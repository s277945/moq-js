import { RingShared } from "../../../common/ring.js"

export interface From {
	config?: Config
}

export interface Config {
	channels: number
	sampleRate: number

	ring: RingShared
}
