import { Connection, SubscribeRecv } from "../transport"
import { asError } from "../common/error"
import { Segment } from "./segment"
import { Track } from "./track"
import { Catalog, Mp4Track, VideoTrack, Track as CatalogTrack, AudioTrack } from "../media/catalog"

import { isAudioTrackSettings, isVideoTrackSettings } from "../common/settings"

export interface BroadcastConfig {
	connection: Connection
	media?: MediaStream

	audio?: AudioEncoderConfig
	video?: VideoEncoderConfig

	generator?: GeneratorConfig
}

export interface GeneratorConfig {
	audio: boolean
	video: boolean
	videoCodec: string
	width: number
	height: number
	frameRate: number
	videoBitRate: number | undefined
	audioCodec: string
	sampleRate: number
	sampleSize: number
	channelCount: number
	audioBitRate: number | undefined
}

export interface BroadcastConfigTrack {
	codec: string
	bitrate: number
}

export class Broadcast {
	#tracks = new Map<string, Track>()

	readonly config: BroadcastConfig
	readonly catalog: Catalog
	readonly connection: Connection

	#running: Promise<void>

	constructor(config: BroadcastConfig) {
		this.connection = config.connection
		this.config = config
		this.catalog = new Catalog()
		if (this.config.media) {
			for (const media of this.config.media.getTracks()) {
				const track = new Track(media, config)
				this.#tracks.set(track.name, track)

				const settings = media.getSettings()

				let catalog: CatalogTrack

				const mp4Catalog: Mp4Track = {
					container: "mp4",
					kind: media.kind,
					init_track: `${track.name}.mp4`,
					data_track: `${track.name}.m4s`,
				}

				if (isVideoTrackSettings(settings)) {
					if (!config.video) {
						throw new Error("no video configuration provided")
					}

					const videoCatalog: VideoTrack = {
						...mp4Catalog,
						kind: "video",
						codec: config.video.codec,
						width: settings.width,
						height: settings.height,
						frame_rate: settings.frameRate,
						bit_rate: config.video.bitrate,
					}

					catalog = videoCatalog
				} else if (isAudioTrackSettings(settings)) {
					if (!config.audio) {
						throw new Error("no audio configuration provided")
					}

					const audioCatalog: AudioTrack = {
						...mp4Catalog,
						kind: "audio",
						codec: config.audio.codec,
						sample_rate: settings.sampleRate,
						sample_size: settings.sampleSize,
						channel_count: settings.channelCount,
						bit_rate: config.audio.bitrate,
					}

					catalog = audioCatalog
				} else {
					throw new Error(`unknown track type: ${media.kind}`)
				}

				this.catalog.tracks.push(catalog)
			}
		} else if (this.config.generator) {
			const generatorSettings = this.config.generator
			const mp4CatalogV: Mp4Track = {
				container: "mp4",
				kind: "mp4",
				init_track: `testVideo.mp4`,
				data_track: `testVideo.m4s`,
			}
			const videoCatalog: VideoTrack = {
				...mp4CatalogV,
				kind: "video",
				codec: generatorSettings.videoCodec,
				width: generatorSettings.width,
				height: generatorSettings.height,
				frame_rate: generatorSettings.frameRate,
				bit_rate: generatorSettings.videoBitRate,
			}
			const mp4CatalogA: Mp4Track = {
				container: "mp4",
				kind: "mp4",
				init_track: `testAudio.mp4`,
				data_track: `testAudio.m4s`,
			}
			const audioCatalog: AudioTrack = {
				...mp4CatalogA,
				kind: "audio",
				codec: generatorSettings.audioCodec,
				sample_rate: generatorSettings.sampleRate,
				sample_size: generatorSettings.sampleSize,
				channel_count: generatorSettings.channelCount,
				bit_rate: generatorSettings.audioBitRate,
			}
			this.catalog.tracks.push(audioCatalog)
			this.catalog.tracks.push(videoCatalog)
		} else {
			this.#running = new Promise<void>((res, rej) => {
				console.error("Missing track data")
				rej()
			})
			return
		}

		this.#running = this.#run()
	}

	async #run() {
		for (;;) {
			const subscriber = await this.connection.subscribed()
			if (!subscriber) break

			// Run an async task to serve each subscription.
			this.#serveSubscribe(subscriber).catch((e) => {
				const err = asError(e)
				console.warn("failed to serve subscribe", err)
			})
		}
	}

	async #serveSubscribe(subscriber: SubscribeRecv) {
		try {
			const [base, ext] = splitExt(subscriber.track)
			if (ext === "catalog") {
				await this.#serveCatalog(subscriber, base)
			} else if (ext === "mp4") {
				await this.#serveInit(subscriber, base)
			} else if (ext === "m4s") {
				await this.#serveTrack(subscriber, base)
			} else {
				throw new Error(`unknown subscription: ${subscriber.track}`)
			}
		} catch (e) {
			const err = asError(e)
			await subscriber.close(1n, `failed to process subscribe: ${err.message}`)
		} finally {
			// TODO we can't close subscribers because there's no support for clean termination
			// await subscriber.close()
		}
	}

	async #serveCatalog(subscriber: SubscribeRecv, name: string) {
		// We only support ".catalog"
		if (name !== "") throw new Error(`unknown catalog: ${name}`)

		const bytes = this.catalog.encode()

		// Send a SUBSCRIBE_OK
		await subscriber.ack()

		const stream = await subscriber.data({
			group: 0,
			object: 0,
			priority: 0,
		})

		const writer = stream.getWriter()

		try {
			await writer.write(bytes)
			await writer.close()
		} catch (e) {
			const err = asError(e)
			await writer.abort(err.message)
			throw err
		} finally {
			writer.releaseLock()
		}
	}

	async #serveInit(subscriber: SubscribeRecv, name: string) {
		const track = this.#tracks.get(name)
		if (!track) throw new Error(`no track with name ${subscriber.track}`)

		// Send a SUBSCRIBE_OK
		await subscriber.ack()

		const init = await track.init()

		// Create a new stream for each segment.
		const stream = await subscriber.data({
			group: 0,
			object: 0,
			priority: 0, // TODO
			expires: 0, // Never expires
		})

		const writer = stream.getWriter()

		// TODO make a helper to pipe a Uint8Array to a stream
		try {
			// Write the init segment to the stream.
			await writer.write(init)
			await writer.close()
		} catch (e) {
			const err = asError(e)
			await writer.abort(err.message)
			throw err
		} finally {
			writer.releaseLock()
		}
	}

	async #serveTrack(subscriber: SubscribeRecv, name: string) {
		const track = this.#tracks.get(name)
		if (!track) throw new Error(`no track with name ${subscriber.track}`)

		// Send a SUBSCRIBE_OK
		await subscriber.ack()

		const segments = track.segments().getReader() //allows to read the track segments

		for (;;) {
			const { value: segment, done } = await segments.read() //read each segment from the track
			if (done) break

			// Serve the segment and log any errors that occur.
			this.#serveSegment(subscriber, segment).catch((e) => {
				const err = asError(e)
				console.warn("failed to serve segment", err)
			})
		}
	}

	async #serveSegment(subscriber: SubscribeRecv, segment: Segment) {
		// Create a new stream for each segment.
		const stream = await subscriber.data({
			group: segment.id,
			object: 0,
			priority: 0, // TODO
			expires: 30, // TODO configurable
		})

		// Pipe the segment to the stream.
		await segment.chunks().pipeTo(stream)
	}

	// Attach the captured video stream to the given video element.
	attach(video: HTMLVideoElement) {
		video.srcObject = this.config.media ? this.config.media : null
	}

	close() {
		// TODO implement publish close
	}

	// Returns the error message when the connection is closed
	async closed(): Promise<Error> {
		try {
			await this.#running
			return new Error("closed") // clean termination
		} catch (e) {
			return asError(e)
		}
	}
}

function splitExt(s: string): [string, string] {
	const i = s.lastIndexOf(".")
	if (i < 0) throw new Error(`no extension found`)
	return [s.substring(0, i), s.substring(i + 1)]
}
