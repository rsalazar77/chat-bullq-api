-- Gatilho de automação para comentário em post/reels do Instagram.
-- Postgres não permite ALTER TYPE ... ADD VALUE dentro de transação em
-- versões antigas; o Prisma roda cada migration numa transação, então
-- usamos a forma IF NOT EXISTS suportada do PG 12+.
ALTER TYPE "AutomationTrigger" ADD VALUE IF NOT EXISTS 'COMMENT_RECEIVED';
