import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// チャットモードの画面側（chat.ts の useChatTomo）。会話の続き（履歴・要約）を持ち、毎回サーバーに送る
// 要約はサーバーがして、返事といっしょに返す（#2）

const aiApi = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../src/api', () => ({ aiApi }));
const { useChatTomo, SUMMARY_NOTICE } = await import('../src/chat');

const ok = (reply: string) => ({ reply, lookedAtScreen: false, lookedAtNote: false, ms: 1, model: 'm' });

beforeEach(() => { aiApi.chat.mockReset(); });

describe('useChatTomo', () => {
  it('ask：履歴・勉強の様子・画像・計っている時間・要約を送り、返事を履歴に足す', async () => {
    const { result } = renderHook(() => useChatTomo());
    act(() => result.current.load([{ role: 'user', text: '前回' }], { text: 'まとめ', upTo: 1 }));
    aiApi.chat.mockResolvedValueOnce(ok('こんにちは'));
    let r: unknown;
    await act(async () => { r = await result.current.ask('やあ', '学習の回：英語', 'img', 'scr', 'note', { elapsedMs: 0, minutes: 5 }, { cueScreen: 'cue', session: 's1', student: true }); });
    expect(r).toMatchObject({ reply: 'こんにちは' });
    expect(aiApi.chat).toHaveBeenCalledWith('やあ', [{ role: 'user', text: '前回' }], '学習の回：英語', 'img', 'scr', 'note', { elapsedMs: 0, minutes: 5 }, { summary: 'まとめ', cueScreen: 'cue', session: 's1', student: true });

    aiApi.chat.mockResolvedValueOnce(ok('はい'));
    await act(async () => { await result.current.ask('次'); });
    expect(aiApi.chat.mock.calls[1][1]).toEqual([
      { role: 'user', text: '前回' }, { role: 'user', text: 'やあ' }, { role: 'tomo', text: 'こんにちは' },
    ]);
  });

  it('考え中は次の ask を受けつけない（null）', async () => {
    const { result } = renderHook(() => useChatTomo());
    let resolve!: (v: unknown) => void;
    aiApi.chat.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    let first!: Promise<unknown>;
    act(() => { first = result.current.ask('1'); });
    expect(result.current.thinking).toBe(true);
    let second: unknown;
    await act(async () => { second = await result.current.ask('2'); });
    expect(second).toBeNull();
    await act(async () => { resolve(ok('a')); await first; });
    expect(result.current.thinking).toBe(false);
    expect(aiApi.chat).toHaveBeenCalledTimes(1);
  });

  it('失敗したら null で、履歴に足さない', async () => {
    const { result } = renderHook(() => useChatTomo());
    aiApi.chat.mockRejectedValueOnce(new Error('boom'));
    let r: unknown = 'x';
    await act(async () => { r = await result.current.ask('1'); });
    expect(r).toBeNull();
    aiApi.chat.mockResolvedValueOnce(ok('a'));
    await act(async () => { await result.current.ask('2'); });
    expect(aiApi.chat.mock.calls[1][1]).toEqual([]);
  });

  it('remember：セリフや会話モードの発言も履歴に足す', async () => {
    const { result } = renderHook(() => useChatTomo());
    act(() => { result.current.remember('こんにちは'); result.current.remember('英語です', 'user'); });
    aiApi.chat.mockResolvedValueOnce(ok('a'));
    await act(async () => { await result.current.ask('x'); });
    expect(aiApi.chat.mock.calls[0][1]).toEqual([{ role: 'tomo', text: 'こんにちは' }, { role: 'user', text: '英語です' }]);
  });

  it('返事に summary があれば、次から要約を送り、履歴は直近10発言だけ残す', async () => {
    const { result } = renderHook(() => useChatTomo());
    act(() => { for (let i = 1; i <= 13; i++) result.current.remember(`#${i}`); });
    aiApi.chat.mockResolvedValueOnce({ ...ok('#15'), summary: { text: '新しいまとめ', upTo: 5 } });
    await act(async () => { await result.current.ask('#14'); });
    aiApi.chat.mockResolvedValueOnce(ok('a'));
    await act(async () => { await result.current.ask('x'); });
    expect(aiApi.chat.mock.calls[1][1].map((t: { text: string }) => t.text)).toEqual(['#6', '#7', '#8', '#9', '#10', '#11', '#12', '#13', '#14', '#15']);
    expect(aiApi.chat.mock.calls[1][7]).toMatchObject({ summary: '新しいまとめ' });
  });

  it('SUMMARY_NOTICE はサーバーと同じ文', () => {
    expect(SUMMARY_NOTICE).toBe('そろそろ会話の量が増えてきたから、古い内容は要約していくね。');
  });
});
