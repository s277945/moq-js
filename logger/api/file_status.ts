let fileStatusMap: Map<string, fileStatus>;

export function setFileStatus(fname: string, status: number) {
	if (!fileStatusMap) fileStatusMap = new Map<string, fileStatus>();
	let fileS = fileStatusMap.get(fname);
	if (fileS) fileS.loggerServerStatus(status);
	else fileStatusMap.set(fname, new fileStatus(status));
}

export function getFileStatus(fname: string): number | undefined {
	if (!fileStatusMap) return undefined;
	let fileS = fileStatusMap.get(fname);
	if (fileS) return fileS.loggerServerStatus();
	else return undefined;
}
// class to read atomic variable for logger status
class fileStatus {
	private buffer: SharedArrayBuffer;
	private uint8: Uint8Array;
	constructor(status: number) {
		this.buffer = new SharedArrayBuffer(1);
		this.uint8 = new Uint8Array(this.buffer);
		this.uint8[0] = status;
	}

	public loggerServerStatus(newStatus?: number): number {
		if (newStatus != undefined) {
			return Atomics.store(this.uint8, 0, newStatus);
		}
		return Atomics.load(this.uint8, 0);
	}
}
