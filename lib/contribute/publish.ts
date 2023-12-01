import { Broadcast, VideoEncoder, AudioEncoder } from "@kixelated/moq/contribute"
import { Client, Connection } from "@kixelated/moq/transport"
import { initLoggerFile, getCachedLoggerStatus } from "@kixelated/moq/common"

interface AudioTrackSettings {
	autoGainControl: boolean
	channelCount: number
	deviceId: string
	echoCancellation: boolean
	facingMode: string
	groupId: string
	noiseSuppression: boolean
	sampleRate: number
	sampleSize: number
}

interface VideoTrackSettings {
	aspectRatio: number
	deviceId: string
	displaySurface: string
	facingMode: string
	frameRate: number
	groupId: string
	height: number
	width: number
}

interface VideoCodec {
	name: string
	profile: string
	value: string
}

const PUBLIC_RELAY_HOST = "130.192.16.111:4443"

const AUDIO_BITRATE = 0
const VIDEO_BITRATE = 0

const AUDIO_CODECS = [
	"Opus",
	// ,
	// "mp4a", // TODO support AAC
]

const VIDEO_CODECS: VideoCodec[] = [
	// HEVC Main10 Profile, Main Tier, Level 4.0
	{ name: "h.265", profile: "main", value: "hev1.2.4.L120.B0" },

	// AV1 Main Profile, level 3.0, Main tier, 8 bits
	{ name: "av1", profile: "main", value: "av01.0.04M.08" },

	// AVC High Level 3
	{ name: "h.264", profile: "high", value: "avc1.64001e" },

	// AVC High Level 4
	{ name: "h.264", profile: "high", value: "avc1.640028" },

	// AVC High Level 5
	{ name: "h.264", profile: "high", value: "avc1.640032" },

	// AVC High Level 5.2
	{ name: "h.264", profile: "high", value: "avc1.640034" },

	// AVC Main Level 3
	{ name: "h.264", profile: "main", value: "avc1.4d001e" },

	// AVC Main Level 4
	{ name: "h.264", profile: "main", value: "avc1.4d0028" },

	// AVC Main Level 5
	{ name: "h.264", profile: "main", value: "avc1.4d0032" },

	// AVC Main Level 5.2
	{ name: "h.264", profile: "main", value: "avc1.4d0034" },

	// AVC Baseline Level 3
	{ name: "h.264", profile: "baseline", value: "avc1.42001e" },

	// AVC Baseline Level 4
	{ name: "h.264", profile: "baseline", value: "avc1.420028" },

	// AVC Baseline Level 5
	{ name: "h.264", profile: "baseline", value: "avc1.420032" },

	// AVC Baseline Level 5.2
	{ name: "h.264", profile: "baseline", value: "avc1.420034" },
]

const SUPPORTED_HEIGHT = [240, 360, 480, 720, 1080, 1440]
const SUPPORTED_FPS = [15, 30, 60]

const DEFAULT_HEIGHT = 480
const DEFAULT_FPS = 30

class Publisher {
	// connection: Connection
	// broadcast: Broadcast
	audio: AudioEncoderConfig | undefined
	video: VideoEncoderConfig | undefined
	// device: MediaStream
	audiotrack: AudioTrackSettings | undefined
	videotrack: VideoTrackSettings | undefined
	// constructor() {}

	async create() {
		const id = crypto.randomUUID()
		const server = PUBLIC_RELAY_HOST
		const url = `https://${server}/${id}`
		const fingerprint = server ? `https://${server}/fingerprint` : undefined
		const client = new Client({
			url,
			fingerprint,
			role: "publisher",
		})
		let connection: Connection
		await client.connect().then((value) => {
			connection = value

			const device = new MediaStream()
			let audiotrack: AudioTrackSettings
			let videotrack: VideoTrackSettings
			let audioConfig: AudioEncoderConfig
			let videoConfig: VideoEncoderConfig

			const audio = new Promise<void>((resolve, reject) => {
				const audioTracks = device?.getAudioTracks()
				if (audioTracks && audioTracks.length != 0) {
					audiotrack = audioTracks[0].getSettings() as AudioTrackSettings
					const bitrate = AUDIO_BITRATE > 0 ? AUDIO_BITRATE : 128_000

					const isSupported = async (config: AudioEncoderConfig) => {
						const supported = await AudioEncoder.isSupported(config)
						if (supported) return config
					}
					console.log("Audio bitrate set to:", bitrate)

					const audioPromises = AUDIO_CODECS.map((codec) =>
						isSupported({
							codec,
							bitrate: bitrate,
							numberOfChannels: audiotrack.channelCount,
							sampleRate: audiotrack.sampleRate,
						}),
					)

					let audioSupported: string[] = []
					Promise.all(audioPromises)
						.then((configs) => configs.filter((config) => config))
						.then((configs) => configs.map((config) => config?.codec ?? "")) // it won't be ""
						.then((supported) => (audioSupported = supported))
						.catch((error) => console.error(error))

					if (audioSupported.indexOf(AUDIO_CODECS[0]) != -1) {
						// The selected codec is valid
						audioConfig = {
							codec: AUDIO_CODECS[0],
							bitrate: bitrate,
							numberOfChannels: audiotrack.channelCount,
							sampleRate: audiotrack.sampleRate,
						}
						resolve()
					} else reject("Audio codec not found")
				}
			})

			const video = new Promise<void>((resolve, reject) => {
				const videoTracks = device?.getVideoTracks()
				if (videoTracks && videoTracks.length != 0) {
					videotrack = videoTracks[0].getSettings() as VideoTrackSettings
					const bitrate = VIDEO_BITRATE > 0 ? VIDEO_BITRATE : 2_000_000

					const supportedHeight = () => {
						const options = SUPPORTED_HEIGHT.filter((h) => h <= videotrack.height)

						// Use the device height by default
						if (options.indexOf(videotrack.height) == -1) {
							options.push(videotrack.height)
							options.sort()
						}

						return options
					}

					const supportedFps = () => {
						const options = SUPPORTED_FPS.filter((f) => f <= videotrack.frameRate)

						// Use the device framerate by default
						if (options.indexOf(videotrack.frameRate) == -1) {
							options.push(videotrack.frameRate)
							options.sort()
						}

						return options
					}

					const width = (height: number) => {
						// Round to the nearest multiple of 2.
						return 2 * Math.ceil((height * videotrack.width) / videotrack.height / 2)
					}

					let h: number
					if (supportedHeight().indexOf(DEFAULT_HEIGHT) == -1) {
						h = videotrack.height
					} else h = DEFAULT_HEIGHT

					let f: number
					if (supportedFps().indexOf(DEFAULT_FPS) == -1) {
						f = videotrack.frameRate
					} else f = DEFAULT_FPS

					const isSupported = async (codec: VideoCodec) => {
						const supported = await VideoEncoder.isSupported({
							codec: codec.value,
							width: width(h),
							height: h,
							framerate: f,
							bitrate: bitrate,
						})

						if (supported) return codec
					}

					const videopromises = VIDEO_CODECS.map((codec) => isSupported(codec))

					let videoSupported: VideoCodec[] = []
					// Wait for all of the promises to return
					Promise.all(videopromises)
						.then((codecs) => codecs.filter((codec): codec is VideoCodec => !!codec))
						.then((supported) => (videoSupported = supported))
						.catch((error) => console.error(error))

					if (!videoSupported || videoSupported.length == 0) return
					let videoCodec: VideoCodec | undefined
					VIDEO_CODECS.forEach((codec) => {
						const i = videoSupported.indexOf(codec)
						if (i != -1) {
							// The selected codec is valid
							videoCodec = videoSupported.at(i)
						}
					})
					if (videoCodec) {
						videoConfig = {
							codec: videoCodec.value,
							height: h,
							width: width(h),
							bitrate: bitrate,
							framerate: f,
						}
						resolve()
					} else reject("Video codec not found")
				}
			})
			const promises: Promise<void>[] = [audio, video]
			Promise.all(promises)
				.then(() => {
					new Broadcast({
						connection: value,
						media: device,
						audio: audioConfig,
						video: videoConfig,
					})
				})
				.catch(() => {
					console.error("Could not initialize broadcast")
				})
		})
	}
}
