import { Reader, Writer } from "./stream"
import { postLogDataAndForget } from "../common/index"
export { Reader, Writer }
import { Mutex } from "async-mutex"
import { Channel } from "queueable"

// This is OBJECT but we can't use that name because it's a reserved word.

export interface Header {
	track: bigint
	group: number // The group sequence, as a number because 2^53 is enough.
	object: number // The object sequence within a group, as a number because 2^53 is enough.
	priority: number // VarInt with a u32 maximum value
	expires?: number // optional: expiration in seconds
	size?: number // optional: size of payload, otherwise it continues until end of stream
	timestamp?: number // optional: timestamp for latency value
}

interface Datagram {
	number: number
	data: Uint8Array
}

interface Group {
	currentChunk: number
	chunks: Map<number, Datagram[]>
	readyChunks: Channel<Uint8Array>
	delete?: () => void
	done: boolean
	timeout?: NodeJS.Timeout
}

export class Objects {
	private quic: WebTransport
	private chunkStartPatternMap: Map<string, string>
	private datagramMode?: boolean
	private chunksMap: Map<string, Map<number, Group>>
	private mutex: Mutex
	private writer?: WritableStreamDefaultWriter<any>

	constructor(quic: WebTransport, datagramMode?: boolean) {
		this.quic = quic
		this.chunkStartPatternMap = new Map<string, string>()
		this.datagramMode = datagramMode ?? false
		this.chunksMap = new Map<string, Map<number, Group>>()
		this.mutex = new Mutex()
	}

	async sendDatagram(datagram: Uint8Array) {
		if (!this.writer) this.writer = this.quic.datagrams.writable.getWriter() // get quic instance datagrams writer
		// const w = this.quic.datagrams.writable.getWriter() // get quic instance datagrams writer
		await this.writer.write(datagram) // send datagram to quic
	}

	async send(header: Header): Promise<WritableStream<Uint8Array>> {
		const stream = await this.quic.createUnidirectionalStream() //creates a new quic stream
		header.timestamp = Date.now()
		await this.#encode(stream, header) //writes object inside stream
		//console.log("sent object: ", header) //object sent log
		postLogDataAndForget({
			object: header.object,
			group: header.group,
			track: BigInt(header.track).toString(), // converted to string because bigint is not natively supported in JSON
			status: "sent",
			sender_ts: header.timestamp,
			jitter: 0,
		})

		const patternMap = this.chunkStartPatternMap
		let trackPattern = patternMap.get(header.track.toString()) // get track data chunk start pattern
		let object_chunk_count = header.object
		const datagramMode = this.datagramMode
		const sendDatagram = (datagram: Uint8Array) => this.sendDatagram(datagram) // function that calls sendDatagram inside TransformStream

		const tstream = new TransformStream({
			// trasform stream to pipe through data chunks and log their dispatch
			async transform(chunk, controller) {
				chunk = await chunk // await chunk ready for dispatch
				const test = chunk as Uint8Array
				if (!trackPattern) {
					// starting pattern not yet saved
					trackPattern = test.subarray(0, 17).toString() // extract pattern
					patternMap.set(header.track.toString(), trackPattern) // save this starting pattern
				}
				// console.log(chunk, object_chunk_count)
				if (test.subarray(0, 17).toString() == trackPattern) {
					object_chunk_count += 1 // increase chunk counter

					postLogDataAndForget({
						object: object_chunk_count,
						group: header.group,
						track: BigInt(header.track).toString(), // converted to string because bigint is not natively supported in JSON
						status: "sent",
						sender_ts: Date.now(),
						jitter: 0,
					})
				}

				// eslint-disable-next-line no-constant-condition
				if (datagramMode) {
					// chunk is sent as quic datagram
					const data = chunk as Uint8Array
					const slicesNumber = Math.floor(data.length / 1024) // number of slices of 1024

					for (let c = 0, offset = 0; offset < data.length; c++) {
						const sliceLen = c < slicesNumber ? 1024 : data.length - offset // last iteration can have slice size smaller than 1024

						const datagramHeader = new TextEncoder().encode(
							`${header.track} ${header.group} ${object_chunk_count} ${c + 1} ${sliceLen} `, // header format: trackId GroupId ObjectId SliceNum SliceLength
						) // create datagram header
						const datagram = new Uint8Array(sliceLen + datagramHeader.length) // init datagram

						datagram.set(datagramHeader, 0) // write datagram header
						datagram.set(data.subarray(offset, offset + sliceLen), datagramHeader.length) // write datagram data (media chunk)

						await sendDatagram(datagram)

						offset += sliceLen
					}

					const end_chunk = new TextEncoder().encode(
						`${header.track} ${header.group} ${object_chunk_count} ${data.length} end_chunk`, // end chunk message format: trackId GroupId ObjectId ChunkLength 'end_chunk'
					)
					await sendDatagram(end_chunk)
				} else controller.enqueue(chunk) // send packet for dispatch to reliable quic stream
			},
			async flush() {
				if (datagramMode) {
					const end = new TextEncoder().encode(
						`${header.track} ${header.group} end`, // end group message format: trackId GroupId 'end'
					)
					await sendDatagram(end)
				}
			},
		})

		// const w = new Writer(stream)
		// await w.write(end) // send end group message in quic stream

		tstream.readable.pipeThrough({ writable: stream, readable: tstream.readable })
		return tstream.writable
	}

	async recv(): Promise<{ stream: ReadableStream<Uint8Array>; header: Header } | undefined> {
		const streams = this.quic.incomingUnidirectionalStreams.getReader() //allows to access incoming quic streams

		const { value, done } = await streams.read() //reads all incoming streams one at a time
		streams.releaseLock()

		if (done) return
		let stream = value

		const header = await this.#decode(stream) //extracts data from a single stream
		if (header.size) {
			//throw new Error("TODO: handle OBJECT with size")
		}
		//console.log("received object: ", header) //object received log
		if (header.timestamp) {
			// if object timestamp is present, calculate and print latency
			// const latency = Date.now() - header.timestamp
			//console.log("Latency for object ", header.object, "of group", header.group, ":", latency, "ms")
			// send latency data to logger server
			const ts = Date.now()

			postLogDataAndForget({
				object: header.object,
				group: header.group,
				track: BigInt(header.track).toString(), // converted to string because bigint is not natively supported in JSON
				sender_ts: header.timestamp,
				receiver_ts: ts,
				status: "received",
				// jitter: 0,
			})
		}

		if (this.datagramMode) {
			await this.mutex.acquire() // start atomic operation on chunksMap
			let trackMap = this.chunksMap.get(header.track.toString()) // get track groups map
			if (!trackMap) {
				trackMap = new Map<number, Group>()
				this.chunksMap.set(header.track.toString(), trackMap)
			}
			let group = trackMap.get(header.group) // get group datagrams map
			if (!group) {
				group = {
					currentChunk: 1,
					chunks: new Map<number, Datagram[]>(),
					readyChunks: new Channel<Uint8Array>(),
					delete: () => {
						trackMap.delete(header.group)
					},
					done: false,
				}
				trackMap.set(header.group, group)
			}

			this.mutex.release() // end atomic operation on chunksMap

			stream = new ReadableStream({
				async pull(controller) {
					for await (const chunk of group.readyChunks) {
						// wait for datagrams reception
						controller.enqueue(chunk)
						// console.log(chunk)
					}
					controller.close()
					if (group.delete) group.delete() // delete group from datagrams map once all chunks have been processed
				},
			})
		}

		const patternMap = this.chunkStartPatternMap
		let trackPattern = patternMap.get(header.track.toString()) // get track data chunk start pattern
		let object_chunk_count = header.object

		const tstream = new TransformStream({
			// trasform stream to pipe through data chunks and log their arrival
			async transform(chunk, controller) {
				chunk = await chunk // await chunk arrival
				const test = chunk as Uint8Array
				if (!trackPattern) {
					// starting pattern not yet saved
					trackPattern = test.subarray(0, 17).toString() // extract pattern
					patternMap.set(header.track.toString(), trackPattern) // save this starting pattern
				}
				// console.log(chunk, object_chunk_count)
				if (test.subarray(0, 17).toString() == trackPattern) {
					object_chunk_count += 1 // increase chunk counter
					// console.log(chunk, object_chunk_count)

					postLogDataAndForget({
						object: object_chunk_count,
						group: header.group,
						track: BigInt(header.track).toString(), // converted to string because bigint is not natively supported in JSON
						receiver_ts: Date.now(),
						status: "received",
						// jitter: 0,
					})
				}

				controller.enqueue(chunk)
			},
		})
		stream.pipeThrough(tstream)

		return { header, stream: tstream ? tstream.readable : stream }
	}

	async #decode(s: ReadableStream<Uint8Array>) {
		const r = new Reader(s)

		const type = await r.u8()
		if (type !== 0 && type !== 2) {
			throw new Error(`invalid OBJECT type, got ${type}`)
		}

		const has_size = type === 2
		const ts_enabled = true
		return {
			track: await r.u62(),
			group: await r.u53(),
			object: await r.u53(),
			priority: await r.u53(),
			expires: (await r.u53()) || undefined,
			size: has_size ? await r.u53() : undefined,
			timestamp: ts_enabled ? await r.u53() : undefined,
		}
	}

	async #encode(s: WritableStream<Uint8Array>, h: Header) {
		const w = new Writer(s)
		await w.u8(h.size ? 2 : 0)
		await w.u62(h.track)
		await w.u53(h.group)
		await w.u53(h.object)
		await w.u53(h.priority)
		await w.u53(h.expires ?? 0)
		if (h.size) await w.u53(h.size)
		if (h.timestamp) await w.u53(h.timestamp)
	}

	async receiveDatagrams() {
		if (this.datagramMode) {
			const readable = this.quic.datagrams.readable // incoming datagrams as readable stream

			const reader = readable.getReader() // stream reader
			console.log("Datagram reception active")

			for (;;) {
				const { value, done } = await reader.read() // read from stream

				if (value) {
					const res = value as Uint8Array
					const utf = new TextDecoder().decode(res)
					const splitData = utf.split(" ") // split object fields

					if (splitData.length > 5) {
						let header = ""
						for (let i = 0; i < 5; i++) {
							header += splitData[i] + " "
						}
						const offset = new TextEncoder().encode(header).length // get data start offset from header length
						const trackId = Number(splitData.shift()).toString() // decode track id
						const groupId = Number(splitData.shift()) // decode group id number
						const sequenceNum = Number(splitData.shift()) // decode object sequence number
						const sliceNum = Number(splitData.shift()) // decode slice number
						const sliceLen = Number(splitData.shift()) // decode slice number
						const data = res.subarray(offset, res.length) // extract data
						// console.log(data)
						// console.log(sliceLen, offset)
						await this.mutex.acquire() // start atomic operation on chunksMap
						let track = this.chunksMap.get(trackId) // get track chunks map
						if (!track) {
							track = new Map<number, Group>()
							this.chunksMap.set(trackId, track)
						}

						let group = track.get(groupId)
						if (!group) {
							group = {
								currentChunk: 1,
								chunks: new Map<number, Datagram[]>(),
								readyChunks: new Channel<Uint8Array>(),
								delete: () => {
									track.delete(groupId)
								},
								done: false,
							}
							track.set(groupId, group)
						}
						this.mutex.release() // end atomic operation on chunksMap

						let datagrams = group.chunks?.get(sequenceNum)
						if (!datagrams) {
							datagrams = []
							group.chunks?.set(sequenceNum, datagrams)
						}
						datagrams.push({ number: sliceNum, data: data })
						if (group.timeout) clearTimeout(group.timeout) // clear group chunks' queue closure timeout
						group.timeout = setTimeout(() => {
							group.done = true // set group state to done
							void group.readyChunks.push(new Uint8Array(), true) // close ready chunks queue
						}, 2000) // timer that closes the ready chunks queue after time has elapsed with no new datagrams for this group
					} else if (splitData.length == 5) {
						const trackId = Number(splitData.shift()).toString() // decode track id
						const groupId = Number(splitData.shift()) // decode group id number
						const sequenceNum = Number(splitData.shift()) // decode object sequence number
						const sliceLen = Number(splitData.shift()) // decode slice number
						const msg = String(splitData.shift()) // decode message

						const group = this.chunksMap.get(trackId)?.get(groupId)

						if (group && msg == "end_chunk") {
							if (group.currentChunk <= sequenceNum) {
								const chunks = group.chunks // get group chunks map
								if (chunks) {
									const chunk = chunks.get(sequenceNum) // extract chunk for corresponding sequence
									if (chunk) {
										if (chunk.length > 1) {
											// if chunk was sliced, merge slices
											const unfused_data = chunk
												.sort((a, b) => a.number - b.number)
												.map((a) => a.data)

											let length = 0
											unfused_data.forEach((item) => {
												length += item.length
											})

											const data = new Uint8Array(length)
											let offset = 0
											unfused_data.forEach((item) => {
												data.set(item, offset)
												offset += item.length
											})
											// console.log(data.length, sliceLen)
											if (data.length == sliceLen) {
												void group.readyChunks.push(data) // add to chunks ready to be consumed
												group.currentChunk = sequenceNum
											} else
												console.log(
													"corrupted or incomplete chunk",
													sequenceNum,
													"of group",
													groupId,
													"of track",
													trackId,
												)
										} else {
											// console.log(chunk[0].data.length, sliceLen)
											if (chunk[0].data.length == sliceLen) {
												void group.readyChunks.push(chunk[0].data) // add to chunks ready to be consumed
												group.currentChunk = sequenceNum
											} else
												console.log(
													"corrupted or incomplete chunk",
													sequenceNum,
													"of group",
													groupId,
													"of track",
													trackId,
												)
										}
										chunks.delete(sequenceNum) // delete entry from incoming chunks
										if (group.timeout) clearTimeout(group.timeout) // clear group chunks' queue closure timeout
										group.timeout = setTimeout(() => {
											group.done = true // set group state to done
											void group.readyChunks.push(new Uint8Array(), true) // close ready chunks queue
										}, 2000) // timer that closes the ready chunks queue after time has elapsed with no new datagrams for this group
									}
								}
							} else {
								console.log(
									"Discarded late chunk: track",
									trackId,
									"group",
									groupId,
									"object",
									sequenceNum,
								)
							}
						}
					} else if (splitData.length == 3) {
						const trackId = Number(splitData.shift()).toString() // decode track id
						const groupId = Number(splitData.shift()) // decode group id number
						const msg = String(splitData.shift()) // decode message

						const group = this.chunksMap.get(trackId)?.get(groupId) // get group

						// received end message ?
						if (group && msg == "end") {
							if (group.timeout) clearTimeout(group.timeout) // clear group chunks' queue closure timeout
							group.done = true // set group state to done
							void group.readyChunks.push(new Uint8Array(), true) // close ready chunks queue
						}
					}
				}
				if (done) break
			}
		}
	}
}
