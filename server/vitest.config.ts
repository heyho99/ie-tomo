import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Firestore（db.ts）は、どのテストでもメモリの中の偽物にする（fakeDb.ts）
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
  },
});
