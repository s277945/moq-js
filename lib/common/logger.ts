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
// format for latency data
export interface LogData {
	object: number
	group: number
	track: string
	latency: number
}

// function to get logger server status
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
// function to get cached logger server status
export function getCachedLoggerStatus(): boolean {
	return loggerServerStatus() == (0 | 2) ? false : true
}
// function to post latency in LogData format in fire and forget manner
export function postLogDataAndForget(data: LogData): void {
	if (data && loggerServerStatus() == 1)
		fetch("http://localhost:3000/latency-data", {
			method: "POST",
			body: JSON.stringify(data),
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
