// Pump.fun paper bot entrypoint: the strategy lives in strategy.ts and the
// SDK shim is vendored beside it. The grader runs `node /bot/main.ts`.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
