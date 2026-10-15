import { act, fireEvent, render, screen as view, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 学習画面（Study.tsx）の結合テスト。合図・セリフ・生徒の発言が、会話モード（live）とチャットモード（chat）の
// どちらにどんな文で届くか、会話がどう保存されるかを確かめる
// 合図の調停を切り出す（#1）・TomoChannel にまとめる（#2）ときの回帰テスト（会話の保存はサーバーがする。#3）
// カメラ・画面共有・音声認識・Gemini Live の接続は偽物にする（useLiveTomo は呼ばれた関数を記録するだけ）

const m = vi.hoisted(() => {
  const fn = () => ({}) as any;
  return {
    api: { session: fn, messages: fn },
    aiApi: { status: fn, chat: fn, nudgeRules: fn, readNote: fn },
    live: {} as any, // useLiveTomo の返り値（say・nudge などは vi.fn）
    liveOpts: null as any, // useLiveTomo に渡されたもの（onStudent などを呼んで、サーバーから届いたことにする）
    face: null as any, // FaceCamera に渡されたもの（onNudge を呼んで、顔の合図を出す）
    video: false, // 手元カメラが映っている
    screen: { sharing: false },
  };
});
vi.mock('../src/api', () => ({ api: m.api, aiApi: m.aiApi }));
vi.mock('../src/live', async () => {
  const { useState } = await import('react');
  return {
    useLiveTomo: (o: any) => {
      m.liveOpts = o;
      const [live] = useState(() => {
        m.live = {
          status: 'ready', error: '', micError: '', speaking: false, draft: { student: '', tomo: '' },
          say: vi.fn(), text: vi.fn(), nudge: vi.fn(), context: vi.fn(), timer: vi.fn(), notice: vi.fn(), check: vi.fn(), hush: vi.fn(), reconnect: vi.fn(),
        };
        return m.live;
      });
      return live;
    },
  };
});
vi.mock('../src/components/FaceCamera', () => ({ FaceCamera: (p: any) => { m.face = p; return null; } }));
vi.mock('../src/components/HandCamera', () => ({
  HandCamera: (p: any) => {
    useEffect(() => { if (m.video) { p.onStatus?.(true); p.onVideo?.({} as HTMLVideoElement); } }, []);
    return null;
  },
  cameraCapture: () => () => ({ image: 'data:image/jpeg;base64,NOTE', width: 1, height: 1 }),
}));
vi.mock('../src/components/PadNote', () => ({ PadNote: () => null }));
vi.mock('../src/components/ScreenInk', () => ({ ScreenStage: () => null, ScreenDraw: () => null }));
vi.mock('../src/components/Header', () => ({ Header: (p: any) => <header>{p.right}</header> }));
vi.mock('../src/screen', () => ({
  screenShareSupported: () => true,
  useScreenShare: () => ({
    sharing: m.screen.sharing, error: '', stream: null, label: '', lastLook: null,
    start: vi.fn(), stop: vi.fn(), capture: () => (m.screen.sharing ? 'data:image/png;base64,SCR' : null), looked: vi.fn(), ink: { strokes: [], clear: vi.fn() },
  }),
}));
vi.mock('../src/speech', () => ({
  speechSupported: false,
  useListening: () => ({ listening: false, interim: '', error: '', code: '', clearError: vi.fn() }),
  openMic: vi.fn(), micErrorText: () => '',
}));

const SESSION = { id: 's1', title: '英語', createdAt: 'x', updatedAt: 'x' };
const RULES = {
  noteIntervalSec: 10,
  note: { unreadable: 2, stuck: 2 },
  face: { sleepySec: 10, sleepyCooldownSec: 60, downSec: 10, downCooldownSec: 60 },
  interest: { quiet: { on: false, minSec: 60, maxSec: 60 }, milestone: { on: false, everyMin: 15 }, recovered: { on: false, cooldownSec: 60 } },
};
const status = (over: { chat?: boolean; live?: boolean; note?: boolean } = {}) => ({
  purposes: {
    chat: { ready: over.chat ?? true, model: 'm', label: 'chat' },
    live: { ready: over.live ?? true, model: 'm', label: 'live' },
    note: { ready: over.note ?? true, model: 'm', label: 'note' },
  },
  tools: { look_at_screen: true, look_at_note: true, timer: true, pause_study: true },
});
const reply = (r: object = {}) => ({ reply: 'はい', lookedAtScreen: false, lookedAtNote: false, ms: 1, model: 'm', ...r });

/** 話し方（会話モード・チャットモード）を選んで学習画面を開き、読み込み終わるまで待つ */
async function openStudy(talkMode: 'voice' | 'chat', opts: { past?: object[]; ai?: ReturnType<typeof status>; settings?: object; session?: object } = {}) {
  localStorage.setItem('tonari-sensei:settings', JSON.stringify({ talkMode, faceOn: true, ...opts.settings }));
  vi.resetModules(); // 設定・声かけの基準は読み込み時に持つので、毎回読みなおす
  m.api.session = vi.fn(async () => opts.session ?? SESSION);
  m.api.messages = vi.fn(async () => opts.past ?? []);
  m.aiApi.status = vi.fn(async () => opts.ai ?? status());
  m.aiApi.chat = vi.fn(async () => reply());
  m.aiApi.nudgeRules = vi.fn(async () => RULES);
  m.aiApi.readNote = vi.fn(async () => ({ observation: '', readable: true, unreadableReason: '', progress: 'working' }));
  // Router も Study といっしょに読みなおす（resetModules のあとは別のものになるため）
  const { Study } = await import('../src/pages/Study');
  const { MemoryRouter, Route, Routes } = await import('react-router-dom');
  const page = () => <MemoryRouter initialEntries={['/study/s1']}><Routes><Route path="/study/:id" element={<Study />} /></Routes></MemoryRouter>;
  const r = render(page());
  await view.findByText('英語');
  await act(async () => {}); // AI の状態・声かけの基準が届くまで
  return { ...r, redraw: () => r.rerender(page()) };
}
/** チャットで送ったときの、サーバーが保存に使うもの（学習の回と、生徒の発言か）。会話の保存はサーバーがする（server/test） */
const saveInfo = (i = 0) => { const { session, student } = m.aiApi.chat.mock.calls.at(i)[7]; return { session, student }; };

beforeEach(() => {
  m.video = false;
  m.screen.sharing = false;
});
afterEach(() => { vi.useRealTimers(); });

describe('会話モード', () => {
  it('つないで、勉強の様子とあいさつのセリフを送る', async () => {
    await openStudy('voice');
    expect(m.liveOpts).toMatchObject({ enabled: true, sessionId: 's1' });
    expect(m.live.context).toHaveBeenLastCalledWith('学習の回：英語\n画面共有：オフ（家トモには生徒の画面が見えない）');
    expect(m.live.say).toHaveBeenCalledTimes(1);
    expect(m.live.say.mock.calls[0][0]).toMatch(/今日は何を勉強するんですか？$/);
    expect(view.getByText(m.live.say.mock.calls[0][0])).toBeTruthy();
  });

  it('これまでの会話を出し、続きのあいさつをする', async () => {
    await openStudy('voice', { past: [{ who: 'me', text: '前の発言', at: 1 }, { who: 'tomo', text: '前の返事', at: 2 }] });
    expect(view.getByText('前の発言')).toBeTruthy();
    expect(view.getByText('前の返事')).toBeTruthy();
    expect(m.live.say.mock.calls[0][0]).toMatch(/前回は何をしていたんでしたっけ？$/);
  });

  it('画面共有をはじめたら勉強の様子を送りなおす', async () => {
    const { redraw } = await openStudy('voice');
    m.screen.sharing = true;
    redraw();
    await waitFor(() => expect(m.live.context).toHaveBeenLastCalledWith(expect.stringContaining('画面共有：オン')));
  });

  it('生徒・家トモの書き起こしを会話に出す（保存はサーバー）', async () => {
    await openStudy('voice');
    act(() => { m.liveOpts.onStudent('これは何？'); m.liveOpts.onTomo('りんごです'); });
    expect(view.getByText('これは何？')).toBeTruthy();
    expect(view.getByText('りんごです')).toBeTruthy();
    expect(m.aiApi.chat).not.toHaveBeenCalled();
  });

  it('要約のお知らせを会話に出す', async () => {
    await openStudy('voice');
    act(() => m.liveOpts.onSummary('まとめていくね'));
    expect(view.getByText('まとめていくね')).toBeTruthy();
  });

  it('顔の合図：眠そう・下を向いている', async () => {
    await openStudy('voice');
    act(() => m.face.onNudge({ kind: 'sleepy', sec: 12 }));
    expect(m.live.nudge).toHaveBeenLastCalledWith('顔カメラの表情の解析で、目を閉じているのが12秒続いています（眠そう）。');
    act(() => m.face.onNudge({ kind: 'down', sec: 30 }));
    expect(m.live.nudge.mock.calls.at(-1)[0]).toContain('30秒続けて下を向いています。手元カメラがオフなので');
    expect(m.aiApi.chat).not.toHaveBeenCalled();
  });

  it('ノートの合図：手が止まっていたら、根拠の画像つきで送る', async () => {
    m.video = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openStudy('voice');
    m.aiApi.readNote = vi.fn(async () => ({ observation: '式', readable: true, unreadableReason: '', progress: 'stuck' }));
    // 読み取りの間隔（10秒）ごとに描画する
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(m.live.nudge).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(m.live.nudge).toHaveBeenCalledWith('手元カメラの画像の判定で2回続けて、ノートが変わっていません（手が止まっている）。', 'data:image/jpeg;base64,NOTE');
  });

  it('家トモが一時中断すると決めたら、2秒後に一時中断して声を止める', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openStudy('voice');
    act(() => m.liveOpts.onStudy('pause'));
    expect(view.queryByText('一時中断しています')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(view.getByText('一時中断しています')).toBeTruthy();
    expect(m.live.hush).toHaveBeenCalled();
    expect(m.liveOpts.micOn).toBe(false);
  });

  it('タイマー：家トモが計りはじめたら出し、時間になったら知らせて止める', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openStudy('voice');
    act(() => m.liveOpts.onTimer({ elapsedMs: 0, minutes: 1 }));
    expect(view.getByText('タイマー')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(m.live.notice).toHaveBeenCalledWith('1分のタイマーが時間になりました。');
    expect(m.live.timer).toHaveBeenCalledWith(null);
    expect(view.queryByText('タイマー')).toBeNull();
  });

  it('続けるかの確認：27分でたずね、3分返事がなければ一時中断', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openStudy('voice', { settings: { faceOn: false } });
    // 判定は1秒ごとなので、たずねるのは 27分〜27分1秒
    await act(async () => { await vi.advanceTimersByTimeAsync(27 * 60_000 + 1000); });
    expect(m.live.check).toHaveBeenCalledWith(expect.stringMatching(/^勉強を続けて27分(1秒)?たちました。3分のうちに続けると返事がなければ、一時中断します。$/));
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60_000 + 2000); });
    expect(view.getByText('一時中断しています')).toBeTruthy();
  });

  it('続けるかの確認：続けると答えたら一時中断しない', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openStudy('voice', { settings: { faceOn: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(27 * 60_000 + 1000); });
    expect(m.live.check).toHaveBeenCalled();
    act(() => m.liveOpts.onStudy('continue'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(view.queryByText('一時中断しています')).toBeNull();
  });
});

describe('チャットモード', () => {
  async function type(text: string) {
    fireEvent.change(view.getByLabelText('家トモに話しかける'), { target: { value: text } });
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '送る' })); });
  }

  it('つながず、あいさつは会話に出すだけ（AI には送らない・保存しない）', async () => {
    await openStudy('chat');
    expect(m.liveOpts.enabled).toBe(false);
    expect(view.getByText(/今日は何を勉強するんですか？$/)).toBeTruthy();
    expect(m.aiApi.chat).not.toHaveBeenCalled();
    expect(m.live.say).not.toHaveBeenCalled();
  });

  it('文字で話しかけると、勉強の様子・あいさつの続きとして、生徒の発言として送り、返事を出す', async () => {
    await openStudy('chat');
    m.aiApi.chat = vi.fn(async () => reply({ reply: 'りんごです' }));
    await type('これは何？');
    const [message, history, context, image, screenImg, note, timer] = m.aiApi.chat.mock.calls[0];
    expect(message).toBe('これは何？');
    expect(history).toEqual([{ role: 'tomo', text: expect.stringMatching(/今日は何を勉強するんですか？$/) }]);
    expect(context).toBe('学習の回：英語\n画面共有：オフ（家トモには生徒の画面が見えない）');
    expect([image, screenImg, note, timer]).toEqual([undefined, undefined, undefined, null]);
    expect(await view.findByText('りんごです')).toBeTruthy();
    expect(saveInfo()).toEqual({ session: 's1', student: true });
  });

  it('画面共有中・手元カメラが映っていれば、発言といっしょにいまの画像を送る', async () => {
    m.screen.sharing = true;
    m.video = true;
    await openStudy('chat');
    await type('見て');
    const [, , , , screenImg, note] = m.aiApi.chat.mock.calls[0];
    expect(screenImg).toBe('data:image/png;base64,SCR');
    expect(note).toBe('data:image/jpeg;base64,NOTE');
  });

  it('顔の合図は「（声かけの合図）」をつけて送る', async () => {
    await openStudy('chat');
    await act(async () => { m.face.onNudge({ kind: 'sleepy', sec: 12 }); });
    expect(m.aiApi.chat.mock.calls[0][0]).toBe('（声かけの合図）顔カメラの表情の解析で、目を閉じているのが12秒続いています（眠そう）。');
    expect(saveInfo()).toEqual({ session: 's1', student: false }); // 合図は生徒の発言として保存しない
    expect(m.live.nudge).not.toHaveBeenCalled();
  });

  it('返事の timer・study を反映する', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openStudy('chat');
    m.aiApi.chat = vi.fn(async () => reply({ timer: { elapsedMs: 0, minutes: 10 } }));
    await type('10分計って');
    expect(view.getByText('タイマー')).toBeTruthy();
    m.aiApi.chat = vi.fn(async () => reply({ study: 'pause' }));
    await type('休みます');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(view.getByText('一時中断しています')).toBeTruthy();
  });

  it('タイマーの知らせ・続けるかの確認も、印をつけて送る', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openStudy('chat', { settings: { faceOn: false } });
    m.aiApi.chat = vi.fn(async () => reply({ timer: { elapsedMs: 0, minutes: 1 } }));
    await type('1分計って');
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(m.aiApi.chat.mock.calls.at(-1)[0]).toBe('（タイマーの知らせ）1分のタイマーが時間になりました。');
    expect(saveInfo(-1).student).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(26 * 60_000 + 1000); });
    expect(m.aiApi.chat.mock.calls.at(-1)[0]).toMatch(/^（続けるかの確認）勉強を続けて27分(1秒)?たちました。/);
  });

  it('サーバーが要約したら（summary）、お知らせを出す', async () => {
    await openStudy('chat');
    m.aiApi.chat = vi.fn(async () => reply({ reply: '答え', summary: { text: 'まとめ', upTo: 1 } }));
    await type('質問');
    expect(view.getByText('そろそろ会話の量が増えてきたから、古い内容は要約していくね。')).toBeTruthy();
  });

  it('答えられなかったときは、おわびを出す', async () => {
    await openStudy('chat');
    m.aiApi.chat = vi.fn(async () => { throw new Error('boom'); });
    await type('質問');
    expect(await view.findByText(/うまく答えられませんでした/)).toBeTruthy();
  });

  it('AI が使えなければ、おわびを出す', async () => {
    await openStudy('chat', { ai: status({ chat: false }) });
    await type('質問');
    expect(view.getByText(/いまは AI が使えないのでお話しできません/)).toBeTruthy();
  });

  it('チャットの続きは、要約と要約より後の発言から始める', async () => {
    const past = [{ who: 'me', text: '古い', at: 1 }, { who: 'tomo', text: '新しい', at: 3 }];
    await openStudy('chat', { past, session: { ...SESSION, summary: { text: 'まとめ', upTo: 2 } } });
    await type('続き');
    const [, history, , , , , , extra] = m.aiApi.chat.mock.calls[0];
    expect(history.slice(0, 1)).toEqual([{ role: 'tomo', text: '新しい' }]);
    expect(extra).toMatchObject({ summary: 'まとめ' });
  });
});
