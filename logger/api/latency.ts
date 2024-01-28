export class Latency {
	private dataMap: Map<string, Map<string, Map<string, Map<string, string>>>>;

	constructor() {
		this.dataMap = new Map<string, Map<string, Map<string, Map<string, string>>>>(); // filename -> track -> group -> chunk -> sender timestamp
	}

	addSenderTS(fileName: string, trackId: string, groupId: string, chunkNum: string, timestamp: string) {
		console.log(fileName, trackId, groupId, chunkNum, timestamp);
		let tracks = this.dataMap.get(fileName);
		if (!tracks) {
			tracks = new Map<string, Map<string, Map<string, string>>>();
			this.dataMap.set(fileName, tracks);
		}
		let groups = tracks.get(trackId);
		if (!groups) {
			groups = new Map<string, Map<string, string>>();
			tracks.set(trackId, groups);
		}
		let chunks = groups.get(groupId);
		if (!chunks) {
			chunks = new Map<string, string>();
			groups.set(chunkNum, chunks);
		}
		chunks.set(chunkNum, timestamp);
		console.log(this.dataMap.get(fileName)?.get(trackId)?.get(groupId)?.get(chunkNum));
	}

	getSenderTS(fileName: string, trackId: string, groupId: string, chunkNum: string): string | undefined {
		if (!fileName || !trackId || !groupId || !chunkNum) return undefined;
		let tracks = this.dataMap.get(fileName);
		if (tracks) {
			let groups = tracks.get(trackId);
			if (groups) {
				let chunks = groups.get(groupId);
				if (chunks) return chunks.get(chunkNum);
			}
		}
		console.log("not found");
		return undefined;
	}

	clearChunkData(fileName: string, trackId: string, groupId: string, chunkNum: string) {
		if (!fileName || !trackId || !groupId) return undefined;
		let tracks = this.dataMap.get(fileName);
		if (tracks) {
			let groups = tracks.get(trackId);
			if (groups) {
				let chunks = groups.get(groupId);
				if (chunks) chunks.delete(chunkNum);
			}
		}
	}

	getLatency(
		fileName: string,
		trackId: string,
		groupId: string,
		chunkNum: string,
		receiverTS: string,
		clear: boolean = false,
	): number | undefined {
		let result = undefined;
		let senderTS = this.getSenderTS(fileName, trackId, groupId, chunkNum);
		if (senderTS && receiverTS) {
			const s_ts = Number(senderTS);
			const r_ts = Number(receiverTS);
			if (!Number.isNaN(s_ts) && !Number.isNaN(r_ts)) result = r_ts - s_ts;
		}
		if (clear) this.clearChunkData(fileName, trackId, groupId, chunkNum);
		return result;
	}
}
