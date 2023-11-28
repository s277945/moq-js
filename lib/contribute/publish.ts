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
const PUBLIC_RELAY_HOST = "130.192.16.111:4443"
const AUDIO_BITRATE = 0
const VIDEO_BITRATE = 0
const AUDIO_CODECS = [
	"Opus",
	"mp4a", // TODO support AAC
]

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

				let audioConfig
				if (audioSupported.indexOf(AUDIO_CODECS[0]) != -1) {
					// The selected codec is valid
					audioConfig = {
						codec: AUDIO_CODECS[0],
						bitrate: bitrate,
						numberOfChannels: audiotrack.channelCount,
						sampleRate: audiotrack.sampleRate,
					}
				}
			}
			const videoTracks = device?.getVideoTracks()
			if (videoTracks && videoTracks.length != 0) {
				videotrack = videoTracks[0].getSettings() as VideoTrackSettings
			}

			new Broadcast({
				connection: value,
				media: device,
				audio: this.audio,
				video: this.video,
			})
		})
	}
}
