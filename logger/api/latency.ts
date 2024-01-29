import { Mutex, MutexInterface } from "async-mutex";

const later = (delay: number) => new Promise((resolve) => setTimeout(resolve, delay));

interface SharedTimestamp {
	value?: string;
	mutex?: Mutex;
}

export class Latency {
	private dataMap: Map<string, Map<string, Map<string, Map<string, SharedTimestamp>>>>;
	constructor() {
		this.dataMap = new Map<string, Map<string, Map<string, Map<string, SharedTimestamp>>>>(); // filename -> track -> group -> chunk -> sender timestamp
	}

	addSenderTS(fileName: string, trackId: string, groupId: string, chunkNum: string, timestamp: string) {
		if (!fileName || !trackId || !groupId || !chunkNum || !timestamp) return;
		let tracks = this.dataMap.get(fileName);
		if (!tracks) {
			tracks = new Map<string, Map<string, Map<string, SharedTimestamp>>>();
			this.dataMap.set(fileName, tracks);
		}
		let groups = tracks.get(trackId);
		if (!groups) {
			groups = new Map<string, Map<string, SharedTimestamp>>();
			tracks.set(trackId, groups);
		}
		let chunks = groups.get(groupId);
		if (!chunks) {
			chunks = new Map<string, SharedTimestamp>();
			groups.set(groupId, chunks);
		}
		let chunk = chunks.get(chunkNum);
		if (chunk) {
			chunk.value = timestamp;
			if (chunk.mutex && chunk.mutex.isLocked()) chunk.mutex.release();
		} else chunks.set(chunkNum, { value: timestamp });
	}

	async getSenderTS(
		fileName: string,
		trackId: string,
		groupId: string,
		chunkNum: string,
	): Promise<string | undefined> {
		if (!fileName || !trackId || !groupId || !chunkNum) return;
		let tracks = this.dataMap.get(fileName);
		if (!tracks) {
			tracks = new Map<string, Map<string, Map<string, SharedTimestamp>>>();
			this.dataMap.set(fileName, tracks);
		}
		let groups = tracks.get(trackId);
		if (!groups) {
			groups = new Map<string, Map<string, SharedTimestamp>>();
			tracks.set(trackId, groups);
		}
		let chunks = groups.get(groupId);
		if (!chunks) {
			chunks = new Map<string, SharedTimestamp>();
			groups.set(groupId, chunks);
		}
		let chunk = chunks.get(chunkNum);
		if (chunk) {
			return chunk.value;
		} else {
			let entry: SharedTimestamp = { mutex: new Mutex() };
			await entry.mutex?.acquire();
			chunks.set(chunkNum, entry);
			await Promise.race([later(100), entry.mutex?.waitForUnlock()]);
			return entry?.value;
		}
	}

	async clearChunkData(fileName: string, trackId: string, groupId: string, chunkNum: string) {
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

	async getLatency(
		fileName: string,
		trackId: string,
		groupId: string,
		chunkNum: string,
		receiverTS: string,
		clear: boolean = false,
	): Promise<number | undefined> {
		let result = undefined;
		let senderTS = await this.getSenderTS(fileName, trackId, groupId, chunkNum);
		if (senderTS && receiverTS) {
			const s_ts = Number(senderTS);
			const r_ts = Number(receiverTS);
			if (!Number.isNaN(s_ts) && !Number.isNaN(r_ts)) result = r_ts - s_ts;
		}
		if (clear) this.clearChunkData(fileName, trackId, groupId, chunkNum);
		return result;
	}
}
