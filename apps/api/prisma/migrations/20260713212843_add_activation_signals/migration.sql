-- AlterTable
ALTER TABLE "WeeklyCapToken" ADD COLUMN     "macdHistRising" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceAbovePrevClose" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "volVsAvg14d" DOUBLE PRECISION;
