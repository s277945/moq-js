/* eslint-disable jsx-a11y/media-has-caption */
import { Player } from "@kixelated/moq/playback"
import { initLoggerFile } from "@kixelated/moq/common/logger"

import Fail from "./fail"

import { createEffect, createMemo, createSelector, createSignal, onCleanup } from "solid-js"

export default function Watch(props: { name: string }) {
	// Use query params to allow overriding environment variables.
	const urlSearchParams = new URLSearchParams(window.location.search)
	const params = Object.fromEntries(urlSearchParams.entries())
	const server = params.server ?? import.meta.env.PUBLIC_RELAY_HOST

	const defaultMode = "VideoDecoder" in window ? "webcodecs" : "mse"
	const [mode, setMode] = createSignal(defaultMode)
	const [error, setError] = createSignal<Error | undefined>()
	const isMode = createSelector(mode)

	// We create a new element each time the mode changes, to avoid SolidJS caching.
	const useElement = createMemo(() => {
		if (isMode("mse")) {
			const video = document.createElement("video")
			video.classList.add("w-full", "rounded-lg", "aspect-video")
			video.muted = true // so we can autoplay
			video.autoplay = true
			video.controls = true
			return video
		} else {
			const canvas = document.createElement("canvas")
			canvas.classList.add("w-full", "rounded-lg", "aspect-video")
			return canvas
		}
	})

	const [usePlayer, setPlayer] = createSignal<Player | undefined>()
	createEffect(() => {
		const urlParams = `https://${server}/${props.name}`.split("&")
		const url = urlParams[0]
		const today = new Date()
		const date = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate()
		const time = today.getHours() + "." + today.getMinutes() + "." + today.getSeconds()
		const dateTime = date + "_" + time

		// Special case localhost to fetch the TLS fingerprint from the server.
		// TODO remove this when WebTransport correctly supports self-signed certificates
		const fingerprint = server ? `https://${server}/fingerprint` : undefined

		const element = useElement()
		//log filename is derived from current date and time
		const loggerFileName = urlParams[1] ? urlParams[1].replace("logFileName=", "") : "log_" + dateTime + ".txt"
		initLoggerFile("Subscriber", loggerFileName) // init logger server and check status
		console.log(url)

		Player.create({ url, fingerprint, logger: loggerFileName }).then(setPlayer).catch(setError)
	})

	createEffect(() => {
		const player = usePlayer()
		if (!player) return

		onCleanup(() => player.close())
		player.closed().then(setError).catch(setError)
	})

	// NOTE: The canvas automatically has width/height set to the decoded video size.
	// TODO shrink it if needed via CSS
	return (
		<>
			<Fail error={error()} />
			{useElement()}

			<h3>Advanced</h3>
			<button
				classList={{
					"bg-green-500": isMode("mse"),
					"hover:bg-green-600": isMode("mse"),
					"text-white": isMode("mse"),
				}}
				onClick={(e) => {
					setMode("mse")
					e.preventDefault()
				}}
				class="rounded-r-none border-r-2 border-r-slate-900"
			>
				Media Source <span class="block text-xs text-gray-200">(higher latency)</span>
			</button>
			<button
				classList={{
					"bg-green-500": isMode("webcodecs"),
					"hover:bg-green-600": isMode("webcodecs"),
					"text-white": isMode("webcodecs"),
				}}
				onClick={(e) => {
					setMode("webcodecs")
					e.preventDefault()
				}}
				class="rounded-l-none"
			>
				WebCodecs <span class="block text-xs text-gray-200">(experimental)</span>
			</button>
		</>
	)
}
