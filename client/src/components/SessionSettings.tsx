import { useEffect, useState, type ReactNode } from 'react';
import { useSettings, type Settings } from '../settings';
import { RotateControl } from './HandCamera';
import { CameraSizeField, FaceOnField, HandSourceField, LiveVoiceField, NoteImageFields, TalkModeField } from './SettingFields';

// この会話内の設定：授業の画面で「設定」と同じ項目を変える。変えた設定はこの会話内だけで使い、「設定」の設定は変えない
// 「設定にもどす」でこの会話内の変更をやめる
// 中の部品は useSettings で読み書きするので、授業の画面の SettingsScope（この会話内の設定）に効く
// 項目の入力欄は「設定」の画面と同じ部品（SettingFields.tsx）を使う

// 「設定」と違う項目の名前。設定を足したら、ここにも足す（足さないと型エラーになる）。sideWidth は仕切りのドラッグで変えるだけなので出さない
const LABELS: Record<Exclude<keyof Settings, 'sideWidth'>, string> = {
  talkMode: '話し方', liveVoice: '声', micId: 'マイク', voiceOn: '家トモの声を出す', micOn: 'マイクのミュート',
  handSource: 'ノートの入力元', handCameraId: '手元カメラ', handCameraOn: '手元カメラのオン・オフ', handCameraRotate: 'カメラの向き',
  handCameraSize: '映像の大きさ', noteMaxSide: '送る画像の長い辺', noteQuality: 'JPEG の画質',
  faceOn: '顔カメラ', faceCameraId: '顔カメラの機器',
};

type Props = {
  /** 「設定」の設定と違う項目 */
  changed: (keyof Settings)[];
  onRevert: () => void;
  onClose: () => void;
  /** 「会話」の欄のいちばん下に出すもの（会話の量のメーター） */
  meter?: ReactNode;
};

export function SessionSettingsPanel({ changed, onRevert, onClose, meter }: Props) {
  const [settings, setSettings] = useSettings();
  const mics = useDevices('audioinput');
  const cams = useDevices('videoinput');
  const voiceMode = settings.talkMode === 'voice';
  const names = changed.map((k) => k in LABELS && LABELS[k as keyof typeof LABELS]).filter(Boolean);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="session-set-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="card session-set" role="dialog" aria-modal="true" aria-labelledby="session-set-title">
        <div className="session-set-head">
          <h2 id="session-set-title" className="h2">この会話内の設定</h2>
          <button type="button" className="btn btn-ghost btn-sm" autoFocus onClick={onClose}>閉じる</button>
        </div>
        <p className="setup-note">ここで変えた設定は、この会話の中だけで使います。「設定」の設定は変わりません。</p>

        <div className="session-set-body">
          <div className="setup-sub-title">会話</div>
          <TalkModeField />
          {voiceMode && <LiveVoiceField />}
          {voiceMode && (
            <label className="toggle">
              <input type="checkbox" checked={settings.voiceOn} onChange={(e) => setSettings({ voiceOn: e.target.checked })} />
              家トモの声を出す
            </label>
          )}
          {voiceMode ? (
            <DeviceSelect label="マイク" devices={mics} value={settings.micId} onChange={(micId) => setSettings({ micId })} />
          ) : (
            <p className="setup-note">チャットモードの聞き取りは、ブラウザの既定のマイクを使います。</p>
          )}
          {meter}

          <div className="setup-sub-title">手元ノート</div>
          <HandSourceField />
          {settings.handSource === 'camera' && (
            <>
              <DeviceSelect label="カメラ" devices={cams} value={settings.handCameraId} onChange={(handCameraId) => setSettings({ handCameraId, handCameraRotate: 0 })} />
              <div className="dev-select"><span>カメラの向き</span></div>
              <RotateControl />
              <CameraSizeField />
            </>
          )}
          {settings.handSource !== 'none' && <NoteImageFields />}

          <div className="setup-sub-title">顔カメラ</div>
          <FaceOnField>顔カメラを使う</FaceOnField>
          {settings.faceOn && <DeviceSelect label="カメラ" devices={cams} value={settings.faceCameraId} onChange={(faceCameraId) => setSettings({ faceCameraId })} />}
        </div>

        <div className="session-set-foot">
          <span className="setup-note">{names.length ? `「設定」と違う項目：${names.join('・')}` : '「設定」の設定のままです'}</span>
          <div className="row-wrap">
            <button type="button" className="btn btn-ghost btn-sm" disabled={!changed.length} onClick={onRevert}>「設定」の設定にもどす</button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** 選べる機器（マイク・カメラ）。ラベルは許可のあとでないと取れない。抜き差ししたら取り直す */
function useDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const load = () => md.enumerateDevices().then((all) => { if (alive) setDevices(all.filter((d) => d.kind === kind && d.deviceId)); }).catch(() => undefined);
    void load();
    md.addEventListener?.('devicechange', load);
    return () => { alive = false; md.removeEventListener?.('devicechange', load); };
  }, [kind]);
  return devices;
}

/** 機器を選ぶ（空はブラウザの既定）。選べるものがなければ出さない */
function DeviceSelect({ label, devices, value, onChange }: { label: string; devices: MediaDeviceInfo[]; value: string; onChange: (id: string) => void }) {
  if (!devices.length) return null;
  return (
    <label className="dev-select">
      <span>{label}</span>
      <select value={devices.some((d) => d.deviceId === value) ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">既定</option>
        {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
      </select>
    </label>
  );
}
