export const USER_FRIENDLY_ERROR =
  'Something went wrong. Please try again or contact support if the problem persists.';

export function friendlyErrorMessage(error: { message?: string }): string {
  const msg = error.message;
  if (!msg) return USER_FRIENDLY_ERROR;
  const isSystemError =
    /stack|sql|postgres|drizzle|prisma|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|500|Internal Server Error|violates|constraint|fatal|Cannot read propert/i.test(
      msg
    );
  if (isSystemError) return USER_FRIENDLY_ERROR;
  return msg;
}
