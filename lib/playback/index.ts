import * as Message from "./webcodecs/message"

import { Connection } from "../transport/connection"
import { Catalog, isAudioTrack, isMp4Track, isVideoTrack, Mp4Track } from "../media/catalog"
import { asError } from "../common/error"
import { postLogDataAndForget } from "../common/index"
import { Mutex, MutexInterface } from "async-mutex"

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

const later = (delay: number) => new Promise((resolve) => setTimeout(resolve, delay))

interface Datagram {
	number: number
	data: Uint8Array
}

interface Group {
	chunks?: Map<number, Datagram[]>
	mutex?: Mutex
	done: boolean
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
	#chunksMap: Map<string, Map<number, Group>>
	#mutex: Mutex

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
		this.#chunksMap = new Map<string, Map<number, Group>>()
		this.#mutex = new Mutex()

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
		if (this.#dataMode == broadcastModeEnum.DATAGRAM)
			await Promise.all([tracks.map((track) => this.#runTrack(track)), this.#runDatagrams()])
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

	async #runDatagrams() {
		const readable = this.#connection.getQuic().datagrams.readable // incoming datagrams as readable stream
		const reader = readable.getReader() // stream reader
		console.log("Datagram reception active")
		for (;;) {
			const { value, done } = await reader.read() // read from stream
			if (value) {
				// console.log(value)
				const res = value as Uint8Array
				const utf = new TextDecoder().decode(res)
				const splitData = utf.split(" ") // split object fields
				console.log(splitData.length)
				if (splitData.length > 3) {
					const trackId = Number(splitData.shift()).toString() // decode track id
					const groupId = Number(splitData.shift()) // decode object sequence number
					const sequenceNum = Number(splitData.shift()) // decode object sequence number
					const sliceNum = Number(splitData.shift()) // decode object sequence number
					const data = res.subarray(32, res.length) // extract data
					// console.log(trackId, sequence, data)
					await this.#mutex.acquire() // start atomic operation on chunksMap
					let track = this.#chunksMap.get(trackId) // get track chunks map
					if (!track) {
						track = new Map<number, Group>()
						this.#chunksMap.set(trackId, track)
					}
					let group = track.get(groupId)
					if (!group) {
						group = { chunks: new Map<number, Datagram[]>(), mutex: new Mutex(), done: false }
						track.set(groupId, group)
					}
					let datagrams = group.chunks?.get(sequenceNum)
					if (!datagrams) {
						datagrams = []
						group.chunks?.set(sequenceNum, datagrams)
					}
					datagrams.push({ number: sliceNum, data: data })
					// console.log(data)
					this.#mutex.release() // end atomic operation on chunksMap
				} else {
					const trackId = Number(splitData.shift()).toString() // decode track id
					const groupId = Number(splitData.shift()) // decode object sequence number
					const msg = String(splitData.shift()) // decode object sequence number
					await this.#mutex.acquire() // start atomic operation on chunksMap
					const group = this.#chunksMap.get(trackId)?.get(groupId)
					if (group && msg == "end") {
						console.log(msg)
						// group end message
						group.done = true // set group state to done
						this.#mutex.release() // end atomic operation on chunksMap
						group.mutex?.release() // release group mutex
					} else this.#mutex.release() // end atomic operation on chunksMap
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

		if (this.#dataMode == broadcastModeEnum.DATAGRAM) {
			// datagram data transmission mode
			try {
				for (;;) {
					const segment = await Promise.race([sub.data(), this.#running])
					if (!segment) break
					await this.#mutex.acquire() // start atomic operation on chunksMap
					let trackMap = this.#chunksMap.get(segment.header.track.toString()) // get track groups map
					if (!trackMap) {
						trackMap = new Map<number, Group>()
						this.#chunksMap.set(segment.header.track.toString(), trackMap)
					}
					let group = trackMap.get(segment.header.group) // get group datagrams map
					if (!group) {
						group = { chunks: new Map<number, Datagram[]>(), mutex: new Mutex(), done: false }
						trackMap.set(segment.header.group, group)
					}
					this.#mutex.release() // end atomic operation on chunksMap
					await group.mutex?.acquire()
					if (!group.done) await Promise.race([later(10000), group.mutex?.waitForUnlock(), this.#running]) // wait for datagrams reception
					console.log(segment)
					// console.log(group)
					if (group.done) {
						// console.log("test", data[0])
						const stream = new ReadableStream({
							start(controller) {
								const chunks = group.chunks // get group chunks map
								if (chunks) {
									// sort chunk map keys in ascending order
									for (const key of [...chunks.keys()].sort((a, b) => a - b)) {
										const chunk = chunks.get(key) // extract a chunk for each sequence (key)
										if (chunk) {
											if (chunk.length > 1) {
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
												console.log(data)
												controller.enqueue(data)
											} else {
												console.log(chunk[0].data)
												controller.enqueue(chunk[0].data)
											}
										}
									}
								}
								controller.close()
							},
						})
						// console.log("test", await stream.getReader().read())
						// console.log("segment received", segment.header, group)
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
