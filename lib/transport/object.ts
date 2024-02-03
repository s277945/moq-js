import { Reader, Writer } from "./stream"
import { postLogDataAndForget } from "../common/index"
export { Reader, Writer }

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

export class Objects {
	private quic: WebTransport
	private chunkStartPatternMap: Map<string, string>

	constructor(quic: WebTransport) {
		this.quic = quic
		this.chunkStartPatternMap = new Map<string, string>()
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
		const stream = value

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
			// if (latency <= 500)
			// maximum object latency to log, objects with higher latency are ignored
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

		return { header, stream: tstream.readable }
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
}
