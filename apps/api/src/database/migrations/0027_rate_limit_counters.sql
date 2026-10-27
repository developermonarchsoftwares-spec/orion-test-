CREATE TABLE "rate_limit_counters" (
	"key" varchar(96) PRIMARY KEY NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_rate_limit_counters_reset_at" ON "rate_limit_counters" USING btree ("reset_at");