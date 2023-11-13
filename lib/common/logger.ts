export interface LogData {
	object: number
	group: number
	track: string
	latency: number
}

export function postLogDataAndForget(data: LogData): void {
	if (data)
		fetch("http://localhost:3000/latency-data", {
			method: "POST",
			body: JSON.stringify(data),
			headers: { "Content-Type": "application/json" },
		})
	return
}

export function postLogStringAndForget(data: string): void {
	fetch("http://localhost:3000/latency-string", {
		method: "POST",
		body: JSON.stringify({ str: data }),
		headers: { "Content-Type": "application/json" },
	})
	return
}

export async function postLogStringAwait(data: string): Promise<void> {
	const response = await fetch("http://localhost:3000/latency-string", {
		method: "POST",
		body: JSON.stringify({ str: data }),
		headers: { "Content-Type": "application/json" },
	})

	if (!response.ok) {
		console.error("Error")
	} else if (response.status >= 400) {
		console.error("HTTP Error: " + response.status + " - " + response.statusText)
	}
}
