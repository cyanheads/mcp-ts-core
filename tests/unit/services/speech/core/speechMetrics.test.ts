/**
 * @fileoverview Tests for speech OTel metrics recording.
 * Verifies that `recordSpeechOp` records the correct counters, histograms,
 * and span attributes on both success and error paths.
 * @module tests/unit/services/speech/core/speechMetrics.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAdd = vi.fn();
const mockRecord = vi.fn();
const mockErrorAdd = vi.fn();

vi.mock('@/utils/telemetry/metrics.js', () => ({
  createCounter: vi.fn((name: string) =>
    name.includes('errors') ? { add: mockErrorAdd } : { add: mockAdd },
  ),
  createHistogram: vi.fn(() => ({ record: mockRecord })),
}));

vi.mock('@/utils/internal/performance.js', () => ({
  nowMs: vi.fn(() => 150),
}));

import { recordSpeechOp } from '@/services/speech/core/speechMetrics.js';

function createMockSpan() {
  return { setAttribute: vi.fn() } as unknown as import('@opentelemetry/api').Span;
}

describe('recordSpeechOp', () => {
  beforeEach(() => {
    mockAdd.mockClear();
    mockRecord.mockClear();
    mockErrorAdd.mockClear();
  });

  it('records counter and duration histogram on TTS success', () => {
    const span = createMockSpan();
    recordSpeechOp(span, 100, true, 'tts', 'elevenlabs');

    expect(mockAdd).toHaveBeenCalledWith(1, {
      'mcp.speech.operation': 'tts',
      'mcp.speech.provider': 'elevenlabs',
      'mcp.speech.success': true,
    });
    expect(mockRecord).toHaveBeenCalledWith(50, {
      'mcp.speech.operation': 'tts',
      'mcp.speech.provider': 'elevenlabs',
    });
  });

  it('records error counter on failure', () => {
    const span = createMockSpan();
    recordSpeechOp(span, 100, false, 'tts', 'elevenlabs');

    expect(mockErrorAdd).toHaveBeenCalledWith(1, {
      'mcp.speech.operation': 'tts',
      'mcp.speech.provider': 'elevenlabs',
    });
    expect(mockAdd).toHaveBeenCalledWith(1, {
      'mcp.speech.operation': 'tts',
      'mcp.speech.provider': 'elevenlabs',
      'mcp.speech.success': false,
    });
  });

  it('does NOT record error counter on success', () => {
    const span = createMockSpan();
    recordSpeechOp(span, 100, true, 'tts', 'elevenlabs');

    expect(mockErrorAdd).not.toHaveBeenCalled();
  });

  it('sets span attributes for duration and success', () => {
    const span = createMockSpan();
    recordSpeechOp(span, 100, true, 'stt', 'openai-whisper');

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.speech.duration_ms', 50);
    expect(span.setAttribute).toHaveBeenCalledWith('mcp.speech.success', true);
  });

  it('sets span success attribute to false on failure', () => {
    const span = createMockSpan();
    recordSpeechOp(span, 100, false, 'tts', 'elevenlabs');

    expect(span.setAttribute).toHaveBeenCalledWith('mcp.speech.success', false);
  });
});
