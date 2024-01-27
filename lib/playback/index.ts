import * as Message from "./webcodecs/message"

import { Connection } from "../transport/connection"
import { Catalog, isAudioTrack, isMp4Track, isVideoTrack, Mp4Track } from "../media/catalog"
import { asError } from "../common/error"

// We support two different playback implementations:
import Webcodecs from "./webcodecs"
import MSE from "./mse"
import { Client } from "../transport/client"

export type Range = Message.Range
export type Timeline = Message.Timeline

export enum broadcastModeEnum {
	STREAM = "reliable",
	DATAGRAM = "unreliable",
}
export interface PlayerConfig {
	url: string
	fingerprint?: string // URL to fetch TLS certificate fingerprint
	element: HTMLCanvasElement | HTMLVideoElement
	logger?: string
	noVideoRender?: boolean
	dataMode?: broadcastModeEnum
}

// This class must be created on the main thread due to AudioContext.
export class Player {
	#backend: Webcodecs | MSE

	// A periodically updated timeline
	//#timeline = new Watch<Timeline | undefined>(undefined)

	#connection: Connection
	#catalog: Catalog
	#noVideoRender: boolean | undefined
	#dataMode?: broadcastModeEnum
	#chunksMap: Map<number, Map<number, Uint8Array[]>>

	// Running is a promise that resolves when the player is closed.
	// #close is called with no error, while #abort is called with an error.
	#running: Promise<void>
	#close!: () => void
	#abort!: (err: Error) => void

	private constructor(
		connection: Connection,
		catalog: Catalog,
		backend: Webcodecs | MSE,
		noVideoRender?: boolean,
		dataMode?: broadcastModeEnum,
	) {
		this.#connection = connection
		this.#catalog = catalog
		this.#backend = backend
		this.#noVideoRender = noVideoRender
		this.#dataMode = dataMode ?? broadcastModeEnum.DATAGRAM
		this.#chunksMap = new Map<number, Map<number, Uint8Array[]>>()

		const abort = new Promise<void>((resolve, reject) => {
			this.#close = resolve
			this.#abort = reject
		})

		// Async work
		this.#running = Promise.race([this.#run(), abort]).catch(this.#close)
	}

	static async create(config: PlayerConfig): Promise<Player> {
		const client = new Client({ url: config.url, fingerprint: config.fingerprint, role: "subscriber" })
		const connection = await client.connect()

		const catalog = await Catalog.fetch(connection)

		let backend

		if (config.element instanceof HTMLCanvasElement) {
			const element = config.element.transferControlToOffscreen()
			backend = new Webcodecs({ element, catalog, logger: config.logger })
		} else {
			backend = new MSE({ element: config.element })
		}

		return new Player(connection, catalog, backend, config.noVideoRender ?? undefined, config.dataMode)
	}

	async #run() {
		const inits = new Set<string>()
		const tracks = new Array<Mp4Track>()
		let audio = false
		let video = false

		for (const track of this.#catalog.tracks) {
			if (!isMp4Track(track)) {
				throw new Error(`expected CMAF track`)
			}

			if (isAudioTrack(track) && this.#backend instanceof MSE) {
				// TODO temporary hack to disable audio in MSE
				continue
			}
			if (isAudioTrack(track)) audio = true
			if (isVideoTrack(track)) video = true
			inits.add(track.init_track)
			tracks.push(track)
		}

		// Call #runInit on each unique init track
		// TODO do this in parallel with #runTrack to remove a round trip
		await Promise.all(Array.from(inits).map((init) => this.#runInit(init)))

		// Call #runTrack on each track
		if (this.#dataMode == broadcastModeEnum.DATAGRAM)
			await Promise.all([tracks.map((track) => this.#runTrack(track)), this.#runDatagrams(audio, video)])
		else await Promise.all(tracks.map((track) => this.#runTrack(track)))
	}

	async #runInit(name: string) {
		const sub = await this.#connection.subscribe("", name)
		try {
			const init = await Promise.race([sub.data(), this.#running])
			if (!init) throw new Error("no init data")

			this.#backend.init({ stream: init.stream, name })
		} finally {
			await sub.close()
		}
	}

	async #runDatagrams(audio: boolean, video: boolean) {
		const readable = this.#connection.getQuic().datagrams.readable // incoming datagram stream
		const reader = readable.getReader() // stream reader
		for (;;) {
			const { value, done } = await reader.read() // read from stream
			if (value) {
				const res = value as Uint8Array
				const utf = new TextDecoder().decode(res)
				const splitData = utf.split(" ") // split object fields
				const trackId = Number(splitData.shift()) // decode track id
				const sequence = Number(splitData.shift()) // decode object sequence number
				const data = res.subarray(16, res.length - 1) // extract data
				// console.log(trackId, sequence, data)

				const track = this.#chunksMap.get(trackId) // get track chunks map
				if (track) {
					const dataArray = track.get(sequence) // get object chunks array
					if (dataArray) {
						dataArray.push(data) // add data to array
					} else {
						const dataArray: Uint8Array[] = [] // create object chunks array
						dataArray.push(data) // add data to array
						track.set(sequence, dataArray) // add data to object data map
					}
				} else {
					const dataMap = new Map<number, Uint8Array[]>() // create object data map
					const dataArray: Uint8Array[] = [] // create object chunks array
					dataArray.push(data) // add data to array
					dataMap.set(sequence, dataArray) // add array to object data map
					this.#chunksMap.set(trackId, dataMap) // add object data map to tracks map
				}
			}

			if (done) break
		}
	}

	async #runTrack(track: Mp4Track) {
		if (track.kind !== "audio" && track.kind !== "video") {
			throw new Error(`unknown track kind: ${track.kind}`)
		}

		const sub = await this.#connection.subscribe("", track.data_track)
		// eslint-disable-next-line no-constant-condition
		if (this.#dataMode == broadcastModeEnum.DATAGRAM) {
			// datagram data transmission mode
			try {
				for (;;) {
					const segment = await Promise.race([sub.data(), this.#running])
					if (!segment) break
					const data = this.#chunksMap.get(Number(segment.header.track))?.get(Number(segment.header.group))
					if (data) {
						// console.log("test", data[0])
						const stream = new ReadableStream({
							start(controller) {
								controller.enqueue(data[0])
								// console.log("added to stream", data[0])
								if (data.length > 1) {
									controller.enqueue(data[1])
									// console.log("added to stream", data[1])
								}
								controller.close()
							},
						})
						// console.log("test", await stream.getReader().read())
						console.log("segment received", segment.header, stream)
						if (track.kind == "audio" || (!this.#noVideoRender && track.kind == "video")) {
							this.#backend.segment({
								init: track.init_track,
								kind: track.kind,
								header: segment.header,
								stream: stream,
							})
						}
					} else console.log("Object datagrams not received")
				}
			} finally {
				await sub.close()
			}
		} else {
			// reliable stream data transmission mode
			try {
				for (;;) {
					const segment = await Promise.race([sub.data(), this.#running])
					if (!segment) break

					if (track.kind == "audio" || (!this.#noVideoRender && track.kind == "video")) {
						this.#backend.segment({
							init: track.init_track,
							kind: track.kind,
							header: segment.header,
							stream: segment.stream,
						})
					}
				}
			} finally {
				await sub.close()
			}
		}
	}

	#onMessage(msg: Message.FromWorker) {
		if (msg.timeline) {
			//this.#timeline.update(msg.timeline)
		}
	}

	async close(err?: Error) {
		if (err) this.#abort(err)
		else this.#close()

		if (this.#connection) this.#connection.close()
		if (this.#backend) await this.#backend.close()
	}

	async closed(): Promise<Error | undefined> {
		try {
			await this.#running
		} catch (e) {
			return asError(e)
		}
	}

	/*
	play() {
		this.#backend.play({ minBuffer: 0.5 }) // TODO configurable
	}

	seek(timestamp: number) {
		this.#backend.seek({ timestamp })
	}
	*/

	async play() {
		await this.#backend.play()
	}

	private async delay(milliseconds = 0, returnValue: any) {
		return new Promise((done) => setTimeout(() => done(returnValue), milliseconds))
	}

	private async isFinished(promise: Promise<any>) {
		return await Promise.race([
			this.delay(0, false),
			promise.then(
				() => true,
				() => true,
			),
		])
	}

	/*
	async *timeline() {
		for (;;) {
			const [timeline, next] = this.#timeline.value()
			if (timeline) yield timeline
			if (!next) break

			await next
		}
	}
	*/
}
