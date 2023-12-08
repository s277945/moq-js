const buffer = new SharedArrayBuffer(1)
const uint8 = new Uint8Array(buffer)
uint8[0] = 0
// function to read atomic variable for logger status
function loggerServerStatus(newStatus?: number): number {
	if (newStatus != undefined) {
		return Atomics.store(uint8, 0, newStatus)
	}
	return Atomics.load(uint8, 0)
}

let fileName = "log.txt"
let lastTimestamp: number // individual timestamp value valid for main thread or worker

// format for latency data
export interface LogData {
	object: number
	group: number
	track: string
	sender_ts?: number
	receiver_ts?: number
	jitter?: number
	latency?: number
	status: string
}

export interface SkippedSegmentData {
	id: number
	reason: string
	track: string
}

export function getLoggerStatus(): void {
	fetch("http://localhost:3000/latency-data", {
		method: "GET",
		headers: { "Content-Type": "application/json" },
	})
		.then((response) => {
			if (!response.ok) {
				console.error("Error on logger server, status:", loggerServerStatus(2))
			} else if (response.status >= 400) {
				console.log("Logger server unreachable" + response.status + " - " + response.statusText)
				console.error("Error on logger server, status:", loggerServerStatus(2))
			} else {
				console.log("Logger server available, status:", loggerServerStatus(1))
			}
		})
		.catch(() => {
			console.log("Logger server unreachable, status:", loggerServerStatus(2))
		})
}
// function to get logger server status
export function initLoggerFile(role: string, fName?: string, segment?: boolean): void {
	fetch("http://localhost:3000/log-init", {
		method: "POST",
		body: fName ? JSON.stringify({ fileName: fName, role: role, segment: segment ? true : false }) : "",
		headers: { "Content-Type": "application/json" },
	})
		.then((response) => {
			if (!response.ok) {
				console.error("Error on logger server, status:", loggerServerStatus(2))
			} else if (response.status >= 400) {
				console.log("Logger server unreachable" + response.status + " - " + response.statusText)
				console.error("Error on logger server, status:", loggerServerStatus(2))
			} else {
				console.log("Logger server available, status:", loggerServerStatus(1))
				if (fName) fileName = fName // save logger file name
			}
		})
		.catch(() => {
			console.log("Logger server unreachable, status:", loggerServerStatus(2))
		})
}
// function to get cached logger server status
export function getCachedLoggerStatus(): boolean {
	return loggerServerStatus() == (0 | 2) ? false : true
}
// function to post logger data in LogData format in fire and forget manner
export function postLogDataAndForget(data: LogData): void {
	// calculate packet jitter if data is available
	if (data.jitter) data.jitter = lastTimestamp && data.sender_ts ? data.sender_ts - lastTimestamp : 0
	// save last timestamp if available
	if (data.sender_ts) lastTimestamp = data.sender_ts
	//send log data
	if (data && loggerServerStatus() == 1)
		fetch("http://localhost:3000/log-data", {
			method: "POST",
			body: JSON.stringify({ data: data, fileName: fileName }),
			headers: { "Content-Type": "application/json" },
		})
	return
}
// function to post latency in LogData format in fire and forget manner
export function postSkippedSegmentIdAndForget(skipped: SkippedSegmentData): void {
	if (skipped && loggerServerStatus() == 1)
		fetch("http://localhost:3000/skipped-segment", {
			method: "POST",
			body: JSON.stringify({ id: skipped.id, track: skipped.track, reason: skipped.reason, fileName: fileName }),
			headers: { "Content-Type": "application/json" },
		})
	return
}
// function to signal client player closure to logger
export function postLogDataEnd(): void {
	if (loggerServerStatus() == 1)
		fetch("http://localhost:3000/log-end", {
			method: "POST",
			body: JSON.stringify({ playerClosed: true }),
			headers: { "Content-Type": "application/json" },
		})
	return
}
// function to post string in fire and forget manner
export function postLogStringAndForget(data: string): void {
	if (data && loggerServerStatus() == 1)
		fetch("http://localhost:3000/latency-string", {
			method: "POST",
			body: JSON.stringify({ str: data }),
			headers: { "Content-Type": "application/json" },
		})
	return
}
// function to post string and await response
export async function postLogStringAwait(data: string): Promise<void> {
	await fetch("http://localhost:3000/latency-string", {
		method: "POST",
		body: JSON.stringify({ str: data }),
		headers: { "Content-Type": "application/json" },
	})
		.then((response) => {
			if (!response.ok) {
				console.error("Error on logger server, status:", loggerServerStatus(2))
			} else if (response.status >= 400) {
				console.log("Logger server unreachable" + response.status + " - " + response.statusText)
				console.error("Error on logger server, status:", loggerServerStatus(2))
			} else {
				console.log("Logger server available, status:", loggerServerStatus(1))
			}
		})
		.catch(() => {
			console.log("Logger server unreachable, status:", loggerServerStatus(2))
		})
	return
}
