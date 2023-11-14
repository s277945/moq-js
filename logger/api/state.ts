const buffer = new SharedArrayBuffer(1);
const uint8 = new Uint8Array(buffer);
uint8[0] = 0;
// function to read atomic variable for logger status
export function loggerServerStatus(newStatus?: number): number {
	if (newStatus != undefined) {
		return Atomics.store(uint8, 0, newStatus);
	}
	return Atomics.load(uint8, 0);
}
