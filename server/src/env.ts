// server/.env があれば環境変数として読み込む（ほかのモジュールより先に import する）
try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // .env がなくても動く（AI は使えない）
}
