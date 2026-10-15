import { useId, type ReactNode } from 'react';
import { LIVE_VOICES, useSettings, type HandSource } from '../settings';
import { MAX_SIDES, QUALITIES } from './CameraLab';
import { CAMERA_SIZES } from './HandCamera';

// 設定の項目（入力欄）。「設定」の画面と、授業の画面の「この会話内の設定」で同じ部品を使う（片方だけ項目が増えたり、選べるものがずれたりしないように）
// どれも useSettings で読み書きするので、置いた場所の SettingsScope（「設定」の下書き・この会話内の設定）に効く

/** 話し方（会話モード・チャットモード） */
export function TalkModeField() {
  const [settings, setSettings] = useSettings();
  const name = useId();
  const voiceMode = settings.talkMode === 'voice';
  return (
    <div className="row-wrap" role="radiogroup" aria-label="話し方">
      <label className="toggle">
        <input type="radio" name={name} checked={voiceMode} onChange={() => setSettings({ talkMode: 'voice' })} />
        会話モード
      </label>
      <label className="toggle">
        <input type="radio" name={name} checked={!voiceMode} onChange={() => setSettings({ talkMode: 'chat' })} />
        チャットモード
      </label>
    </div>
  );
}

/** 会話モードの家トモの声 */
export function LiveVoiceField() {
  const [settings, setSettings] = useSettings();
  return (
    <label className="dev-select">
      <span>声</span>
      <select value={settings.liveVoice} onChange={(e) => setSettings({ liveVoice: e.target.value })}>
        {LIVE_VOICES.map((v) => <option key={v.name} value={v.name}>{v.name}（{v.label}）</option>)}
      </select>
    </label>
  );
}

const HAND_SOURCES: [HandSource, string][] = [['camera', '手元カメラ'], ['pad', 'iPad'], ['none', '使わない']];

/** ノートの入力元（手元カメラ・iPad・使わない）。onChange は変えたあとに呼ぶ */
export function HandSourceField({ onChange }: { onChange?: () => void }) {
  const [settings, setSettings] = useSettings();
  const name = useId();
  return (
    <div className="row-wrap" role="radiogroup" aria-label="ノートの入力元">
      {HAND_SOURCES.map(([v, label]) => (
        <label key={v} className="toggle">
          <input type="radio" name={name} checked={settings.handSource === v} onChange={() => { onChange?.(); setSettings({ handSource: v }); }} />
          {label}
        </label>
      ))}
    </div>
  );
}

/** 手元カメラの映像の大きさ（希望）。children は欄の右に添えるもの（実際の大きさなど） */
export function CameraSizeField({ children }: { children?: ReactNode }) {
  const [settings, setSettings] = useSettings();
  return (
    <label className="dev-select">
      <span>映像の大きさ（希望）</span>
      <select value={settings.handCameraSize} onChange={(e) => setSettings({ handCameraSize: e.target.value })}>
        {CAMERA_SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      {children}
    </label>
  );
}

/** AI に送るノートの画像の長い辺と JPEG の画質 */
export function NoteImageFields() {
  const [settings, setSettings] = useSettings();
  return (
    <>
      <label className="dev-select">
        <span>送る画像の長い辺</span>
        <select value={settings.noteMaxSide} onChange={(e) => setSettings({ noteMaxSide: Number(e.target.value) })}>
          {MAX_SIDES.map((v) => <option key={v} value={v}>{v ? `${v}px` : '縮めない'}</option>)}
        </select>
      </label>
      <label className="dev-select">
        <span>JPEG の画質</span>
        <select value={settings.noteQuality} onChange={(e) => setSettings({ noteQuality: Number(e.target.value) })}>
          {QUALITIES.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
    </>
  );
}

/** 顔カメラを使うか */
export function FaceOnField({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useSettings();
  return (
    <label className="toggle">
      <input type="checkbox" checked={settings.faceOn} onChange={(e) => setSettings({ faceOn: e.target.checked })} />
      {children}
    </label>
  );
}
