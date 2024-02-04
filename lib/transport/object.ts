import { Reader, Writer } from "./stream"
import { postLogDataAndForget } from "../common/index"
export { Reader, Writer }
import { Mutex } from "async-mutex"

// This is OBJECT but we can't use that name because it's a reserved word.

const later = (delay: number) => new Promise((resolve) => setTimeout(resolve, delay))

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
	chunks?: Map<number, Datagram[]>
	mutex?: Mutex
	signal?: Mutex
	delete?: () => void
	done: boolean
}

export class Objects {
	private quic: WebTransport
	private chunkStartPatternMap: Map<string, string>
	private datagramMode?: boolean
	private chunksMap: Map<string, Map<number, Group>>
	private mutex: Mutex

	constructor(quic: WebTransport, datagramMode?: boolean) {
		this.quic = quic
		this.chunkStartPatternMap = new Map<string, string>()
		this.datagramMode = datagramMode ?? false
		this.chunksMap = new Map<string, Map<number, Group>>()
		this.mutex = new Mutex()
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

				controller.enqueue(chunk) // send packet for dispatch to exit stream
			},
		})

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
					mutex: new Mutex(),
					signal: new Mutex(),
					delete: () => {
						trackMap.delete(header.group)
						if (group?.chunks) group.chunks = undefined
					},
					done: false,
				}
				trackMap.set(header.group, group)
			}

			this.mutex.release() // end atomic operation on chunksMap

			// const wait = async () => {
			// 	await this.mutex.acquire()
			// }
			// const release = () => {
			// 	this.mutex.release()
			// }
			stream = new ReadableStream({
				async pull(controller) {
					// await wait() // start atomic operation on chunksMap
					await group.mutex?.acquire()
					await group.signal?.acquire()
					let done = group.done
					// release() // end atomic operation on chunksMap
					if (!done && group.signal?.isLocked()) {
						group.mutex?.release() // release group mutex
						await Promise.race([later(3000), group.signal?.waitForUnlock()])
						await group.mutex?.acquire()
					}
					// wait for datagrams reception
					// await wait() // start atomic operation on chunksMap
					if (group.chunks) {
						let chunk = group.chunks.get(group.currentChunk) // try to get a new chunk
						while (chunk) {
							group.currentChunk += 1 // increase chunk reading position
							controller.enqueue(chunk[0].data) // send chunk to stream
							chunk = group.chunks.get(group.currentChunk) // try to get a new chunk
						}
						done = group.done
						// release() // end atomic operation on chunksMap
						if (done) {
							group.mutex?.release()
							if (group.delete) group.delete()
							controller.close()
						}
					}
					group.mutex?.release() // release group mutex
					// else release() // end atomic operation on chunksMap
				},
			})
		}

		const patternMap = this.chunkStartPatternMap
		let trackPattern = patternMap.get(header.track.toString()) // get track data chunk start pattern
		let object_chunk_count = header.object

		let tstream
		if (!this.datagramMode) {
			tstream = new TransformStream({
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
		}

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

					console.log(splitData.length)
					if (splitData.length > 4) {
						const trackId = Number(splitData.shift()).toString() // decode track id
						const groupId = Number(splitData.shift()) // decode group id number
						const sequenceNum = Number(splitData.shift()) // decode object sequence number
						const sliceNum = Number(splitData.shift()) // decode slice number
						const data = res.subarray(32, res.length) // extract data
						// console.log(trackId, sequence, data)

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
								mutex: new Mutex(),
								signal: new Mutex(),
								delete: () => {
									track.delete(groupId)
									if (group?.chunks) group.chunks = undefined
								},
								done: false,
							}
							track.set(groupId, group)
						}
						this.mutex.release() // end atomic operation on chunksMap

						await group.mutex?.acquire() // acquire group mutex
						let datagrams = group.chunks?.get(sequenceNum)
						if (!datagrams) {
							datagrams = []
							group.chunks?.set(sequenceNum, datagrams)
						}
						datagrams.push({ number: sliceNum, data: data })
						group.mutex?.release() // release group mutex

						// console.log(data)
					} else if (splitData.length == 4) {
						const trackId = Number(splitData.shift()).toString() // decode track id
						const groupId = Number(splitData.shift()) // decode group id number
						const sequenceNum = Number(splitData.shift()) // decode object sequence number
						const msg = String(splitData.shift()) // decode message

						// await this.mutex.acquire() // start atomic operation on chunksMap
						const group = this.chunksMap.get(trackId)?.get(groupId)

						if (group && msg == "end_chunk") {
							// group.signal?.release() // release group mutex
							if (group.currentChunk <= sequenceNum) {
								console.log(msg)
								// chunk end message

								const chunks = group.chunks // get group chunks map
								if (chunks) {
									const chunk = chunks.get(sequenceNum) // extract chunk for corresponding sequence
									if (chunk) {
										// console.log(chunk)
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

											await group.mutex?.acquire() // acquire group mutex
											chunks.set(sequenceNum, [{ number: 0, data: data }])
											group.mutex?.release() // release group mutex
										}
										console.log(chunk[0].data) // chunk ready
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
							// this.mutex.release() // end atomic operation on chunksMap
							group.signal?.release() // release group mutex
						}
						// else this.mutex.release() // end atomic operation on chunksMap
					} else if (splitData.length == 3) {
						const trackId = Number(splitData.shift()).toString() // decode track id
						const groupId = Number(splitData.shift()) // decode group id number
						const msg = String(splitData.shift()) // decode message

						// await this.mutex.acquire() // start atomic operation on chunksMap
						const group = this.chunksMap.get(trackId)?.get(groupId) // get group

						// received end message ?
						if (group && msg == "end") {
							await group.mutex?.acquire() // release group mutex
							group.done = true // set group state to done
							// this.mutex.release() // end atomic operation on chunksMap
							group.mutex?.release() // release group mutex
							group.signal?.release() // release group mutex
						}
						// else this.mutex.release()
					}
				}

				if (done) break
			}
		}
	}
}
