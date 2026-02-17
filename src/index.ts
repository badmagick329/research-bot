import { runCli } from "./cli/main";
import { logger } from "./shared/logger/logger";

const toErrorDetails = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
};

runCli(process.argv).catch((error) => {
  logger.error({ error: toErrorDetails(error) }, "CLI failed");
  process.exit(1);
});
