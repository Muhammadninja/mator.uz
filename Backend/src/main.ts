import { NestFactory } from '@nestjs/core';
import 'dotenv/config';
import { AppModule } from './app.module';
import { prisma } from './database/prisma.service';
import { createTelegramBot } from './telegram/telegram.bot';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);

  const bot = createTelegramBot();
  await bot.launch();
  console.log('🤖 Telegram bot started (long polling)');

  const shutdown = async (signal: string) => {
    console.log(`${signal} received — shutting down`);
    bot.stop(signal);
    await prisma.disconnect();
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
bootstrap();
