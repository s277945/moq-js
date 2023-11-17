import type { Frame } from "../../media/mp4"
import { initLoggerFile, postSkippedSegmentIdAndForget } from "@kixelated/moq/common/index"
export type { Frame }

export interface Range {
	start: number
	end: number
}

export class Timeline {
	// Maintain audio and video seprarately
	audio: Component
	video: Component

	// Construct a timeline
	constructor() {
		this.audio = new Component()
		this.video = new Component()
	}
}

interface Segment {
	sequence: number
	track: bigint //to log skipped segments track number
	frames: ReadableStream<Frame>
}

export class Component {
	#current?: Segment

	frames: ReadableStream<Frame>
	#segments: TransformStream<Segment, Segment>

	constructor() {
		this.frames = new ReadableStream({
			pull: this.#pull.bind(this),
			cancel: this.#cancel.bind(this),
		})
		// This is a hack to have an async channel with 100 items.
		this.#segments = new TransformStream({}, { highWaterMark: 100 })

		const today = new Date()
		const date = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate()
		const time = today.getHours() + "." + today.getMinutes() + "." + today.getSeconds()
		const dateTime = date + "_" + time
		//log filename is derived from current date and time
		initLoggerFile("log_" + dateTime + ".txt", true) // init logger server and check status
	}

	get segments() {
		return this.#segments.writable
	}

	async #pull(controller: ReadableStreamDefaultController<Frame>) {
		for (;;) {
			// Get the next segment to render.
			const segments = this.#segments.readable.getReader()

			let res
			if (this.#current) {
				// Get the next frame to render.
				const frames = this.#current.frames.getReader()

				// Wait for either the frames or segments to be ready.
				// NOTE: This assume that the first promise gets priority.
				res = await Promise.race([frames.read(), segments.read()])

				frames.releaseLock()
			} else {
				res = await segments.read()
			}

			segments.releaseLock()

			const { value, done } = res

			if (done) {
				// We assume the current segment has been closed
				// TODO support the segments stream closing
				this.#current = undefined
				continue
			}
			if (!isSegment(value)) {
				// Return so the reader can decide when to get the next frame.
				controller.enqueue(value)
				return
			}

			// We didn't get any frames, and instead got a new segment.
			if (this.#current) {
				if (value.sequence < this.#current.sequence) {
					// Our segment is older than the current, abandon it.
					console.log(value.sequence)
					//log skipped segment data
					postSkippedSegmentIdAndForget({
						id: value.sequence,
						track: BigInt(value.track).toString(),
						reason: "too old",
					})
					//print data to console
					await value.frames.cancel(
						"skipping segment " +
							value.sequence +
							" of track " +
							BigInt(value.track).toString() +
							" : too old",
					)
					continue
				} else {
					// Our segment is newer than the current, cancel the old one.
					console.log(this.#current.sequence)
					//log skipped segment data
					postSkippedSegmentIdAndForget({
						id: this.#current.sequence,
						track: BigInt(this.#current.track).toString(),
						reason: "too slow",
					})
					//print data to console
					await this.#current.frames.cancel(
						"skipping segment " +
							this.#current.sequence +
							" of track " +
							BigInt(this.#current.track).toString() +
							" : too old",
					)
				}
			}

			this.#current = value
		}
	}

	async #cancel(reason: any) {
		if (this.#current) {
			await this.#current.frames.cancel(reason)
		}

		const segments = this.#segments.readable.getReader()
		for (;;) {
			const { value: segment, done } = await segments.read()
			if (done) break

			await segment.frames.cancel(reason)
		}
	}
}

// Return if a type is a segment or frame
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
function isSegment(value: Segment | Frame): value is Segment {
	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	return (value as Segment).frames !== undefined
}
