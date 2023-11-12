export async function postLogString(data: string): Promise<void> {
	const response = await fetch("http://localhost:3000/latency-data", {
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