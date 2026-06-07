type Writer = (line: string) => void;
let _writer: Writer | null = null;
export function setDebugLog(writer: Writer | null): void { _writer = writer; }
export function dlog(line: string): void { if (_writer) try { _writer(line); } catch {} }
