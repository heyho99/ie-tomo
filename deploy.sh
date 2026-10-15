#!/usr/bin/env bash
# デプロイをまとめて行う（くわしくは README.md の「デプロイ」）
#   ./deploy.sh setup   初回だけ：API の有効化・Firebase の追加・Firestore・サービスアカウント・TTL・ルール
#   ./deploy.sh server  Cloud Run（サーバー）
#   ./deploy.sh web     Firebase Hosting（画面）。Cloud Run の URL を埋め込んでビルドする
#   ./deploy.sh all     server → web
#   ./deploy.sh idle    審査期間が終わったら：常時起動をやめる（min-instances=0）
# プロジェクトは gcloud の設定（gcloud config set project <ID>）か、PROJECT_ID=<ID> ./deploy.sh ... で指定する
# AI の設定を使えるユーザー（ADMIN_UIDS）は server/.env から読む。ADMIN_UIDS=<UID,...> ./deploy.sh server で上書きもできる
set -euo pipefail
cd "$(dirname "$0")"

PROJECT_ID=${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}
REGION=asia-northeast1
SERVICE=tomo
SA=tomo-run@${PROJECT_ID}.iam.gserviceaccount.com
ORIGINS=https://${PROJECT_ID}.web.app,https://${PROJECT_ID}.firebaseapp.com

case "${1:-}" in setup|server|web|all|idle) ;; *) sed -n '2,9p' "$0"; exit 1 ;; esac
[ -n "$PROJECT_ID" ] || { echo 'プロジェクトが決まっていません：gcloud config set project <ID>'; exit 1; }
read -rp "プロジェクト $PROJECT_ID（$REGION）で「$*」を実行します。よいですか？ [y/N] " ok
[ "$ok" = y ] || exit 1

setup() {
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    aiplatform.googleapis.com firestore.googleapis.com firebase.googleapis.com firebasehosting.googleapis.com \
    identitytoolkit.googleapis.com \
    --project "$PROJECT_ID"

  # すでにあるものは飛ばす（何度実行してもよい）
  firebase projects:list --json | grep -q "\"projectId\": \"$PROJECT_ID\"" || firebase projects:addfirebase "$PROJECT_ID"
  gcloud firestore databases describe --project "$PROJECT_ID" >/dev/null 2>&1 \
    || gcloud firestore databases create --location="$REGION" --type=firestore-native --project "$PROJECT_ID"
  gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || gcloud iam service-accounts create tomo-run --display-name="Tomo Cloud Run" --project "$PROJECT_ID"

  # Agent Platform（Gemini / Gemini Live / Claude）と Firestore を使えるようにする
  for role in roles/aiplatform.user roles/datastore.user; do
    # 作った直後は権限の更新がぶつかる（concurrent policy changes）ことがあるので、待ってやり直す
    for wait in 5 10 20 0; do
      gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$role" --condition=None --quiet >/dev/null && break
      [ "$wait" = 0 ] && exit 1
      echo "${wait}秒待ってやり直します"; sleep "$wait"
    done
  done

  # iPad の部屋・デバッグ授業の記録（server/src/debug.ts）を自動で掃除する（expireAt を過ぎたら消える）
  for g in padRooms strokes clients debugEvents debugImages; do
    gcloud firestore fields ttls update expireAt --collection-group="$g" --enable-ttl --async --project "$PROJECT_ID"
  done

  firebase deploy --only firestore:rules --project "$PROJECT_ID"
}

server() {
  # 管理者（AI の設定を使えるユーザー）。--set-env-vars は毎回まるごと置きかえるので、空のままデプロイしない
  local admins=${ADMIN_UIDS:-$(sed -n 's/^ADMIN_UIDS=//p' server/.env 2>/dev/null | tail -1 | tr -d '\r')}
  [ -n "$admins" ] || { echo 'ADMIN_UIDS がありません：server/.env に ADMIN_UIDS=<自分の UID> を書いてください'; exit 1; }
  # 環境変数の区切りを @ にする（ALLOWED_ORIGINS にカンマが入るため）
  gcloud run deploy "$SERVICE" --source . --region "$REGION" --project "$PROJECT_ID" \
    --service-account "$SA" --allow-unauthenticated \
    --min-instances 1 --max-instances 3 --timeout 3600 --session-affinity --cpu 1 --memory 1Gi \
    --clear-secrets \
    --set-env-vars "^@^GOOGLE_CLOUD_PROJECT=$PROJECT_ID@LIVE_LOCATION=us-central1@CLAUDE_REGION=global@ALLOWED_ORIGINS=$ORIGINS@ADMIN_UIDS=$admins"
}

web() {
  local url
  url=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
  # 画面は API・WebSocket・SSE をすべて Cloud Run に直接つなぐ（client/src/serverUrl.ts）。ログインの設定値は client/.env から読む
  VITE_API_ORIGIN=$url npm run build -w client
  firebase deploy --only hosting --project "$PROJECT_ID"
}

idle() {
  gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --min-instances 0
}

case "${1:-}" in
  setup) setup ;;
  server) server ;;
  web) web ;;
  all) server; web ;;
  idle) idle ;;
esac
