import { EvaluationControlFrameSchema, evaluationMethodSchemas, type EvaluationControlFrame } from './evaluation';
import { MAX_FRAME_BYTES } from './protocol';

export function parseEvaluationFrame(line: string, controllerInstanceId?: string): EvaluationControlFrame {
  if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES) throw new Error('frame_too_large');
  const frame = EvaluationControlFrameSchema.parse(JSON.parse(line));
  if (controllerInstanceId !== undefined && frame.controllerInstanceId !== controllerInstanceId) throw new Error('host_protocol_mismatch');
  if (frame.kind === 'reply' && frame.result.ok) evaluationMethodSchemas[frame.method].output.parse(frame.result.data);
  if (frame.kind === 'notice') {
    const notice = frame.notice;
    if (notice.controllerInstanceId !== frame.controllerInstanceId || notice.type === 'eval.status' &&
      (notice.control.controllerInstanceId !== frame.controllerInstanceId || notice.control.executionId !== notice.executionId || notice.control.sequence !== notice.sequence)) throw new Error('invalid_frame');
  }
  return frame;
}
export function encodeEvaluationFrame(value: unknown): string {
  const line = JSON.stringify(value);
  parseEvaluationFrame(line);
  return line + '\n';
}
export class EvaluationFrameDecoder {
  private buffer = new Uint8Array(0);
  constructor(private readonly controllerInstanceId?: string) {}
  push(chunk: Uint8Array): EvaluationControlFrame[] {
    const frames: EvaluationControlFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const end = chunk.indexOf(10, offset), part = chunk.subarray(offset, end === -1 ? chunk.byteLength : end);
      if (this.buffer.byteLength + part.byteLength > MAX_FRAME_BYTES) throw new Error('frame_too_large');
      const bytes = new Uint8Array(this.buffer.byteLength + part.byteLength);
      bytes.set(this.buffer); bytes.set(part, this.buffer.byteLength);
      if (end === -1) { this.buffer = bytes; break; }
      this.buffer = new Uint8Array(0);
      frames.push(parseEvaluationFrame(new TextDecoder('utf-8', { fatal: true }).decode(bytes), this.controllerInstanceId));
      offset = end + 1;
    }
    return frames;
  }
  finish() { if (this.buffer.byteLength) throw new Error('invalid_frame'); }
}
