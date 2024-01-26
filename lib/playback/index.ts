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
	#connection2?: Connection

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
		connection2?: Connection,
	) {
		this.#connection = connection
		this.#catalog = catalog
		this.#backend = backend
		this.#noVideoRender = noVideoRender
		this.#dataMode = dataMode
		this.#connection2 = connection2

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

		let client2 = undefined
		let connection2 = undefined
		if (config.dataMode && config.dataMode == broadcastModeEnum.DATAGRAM) {
			client2 = new Client({ url: config.url, fingerprint: config.fingerprint, role: "subscriber" })
			connection2 = await client2.connect()
		}

		const catalog = await Catalog.fetch(connection)

		let backend

		if (config.element instanceof HTMLCanvasElement) {
			const element = config.element.transferControlToOffscreen()
			backend = new Webcodecs({ element, catalog, logger: config.logger })
		} else {
			backend = new MSE({ element: config.element })
		}

		return new Player(connection, catalog, backend, config.noVideoRender ?? undefined, config.dataMode, connection2)
	}

	async #run() {
		const inits = new Set<string>()
		const tracks = new Array<Mp4Track>()

		for (const track of this.#catalog.tracks) {
			if (!isMp4Track(track)) {
				throw new Error(`expected CMAF track`)
			}

			if (isAudioTrack(track) && this.#backend instanceof MSE) {
				// TODO temporary hack to disable audio in MSE
				continue
			}
			inits.add(track.init_track)
			tracks.push(track)
		}

		// Call #runInit on each unique init track
		// TODO do this in parallel with #runTrack to remove a round trip
		await Promise.all(Array.from(inits).map((init) => this.#runInit(init)))

		// Call #runTrack on each track
		await Promise.all(tracks.map((track) => this.#runTrack(track)))
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

	async #runTrack(track: Mp4Track) {
		if (track.kind !== "audio" && track.kind !== "video") {
			throw new Error(`unknown track kind: ${track.kind}`)
		}

		const sub = await this.#connection.subscribe("", track.data_track)
		// eslint-disable-next-line no-constant-condition
		if (this.#dataMode == broadcastModeEnum.DATAGRAM) {
			// datagram data transmission mode
			const reader = this.#connection.getQuic().datagrams.readable.getReader()
			const stream = new TransformStream()
			const writer = stream.writable.getWriter()
			try {
				for (;;) {
					const segment = await Promise.race([sub.data(), this.#running])
					console.log("a")
					console.log("b")
					const streamReader = segment?.stream.getReader()
					for (;;) {
						const { value, done } = await reader.read()
						console.log(value)
						const r = await reader.read()
						console.log(r)
						// await writer.write(value)
						if (done) break
						// if (streamReader != undefined) {
						// 	const { value, done } = await streamReader.read() // await datagram dispatch confirmation message on stream
						// 	console.log(value)
						// 	if (done) {
						// 		await stream.writable.close()
						// 		break
						// 	}
						// } else streamReader = segment?.stream.getReader()
					}
					if (!segment) break
					if (track.kind == "audio" || (!this.#noVideoRender && track.kind == "video")) {
						this.#backend.segment({
							init: track.init_track,
							kind: track.kind,
							header: segment.header,
							stream: stream.readable,
						})
					}
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
