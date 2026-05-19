import { logoutAction } from "../../server/auth/actions";

export async function POST() {
  await logoutAction();
}
