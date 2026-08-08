import { AccountAuthForm } from "~/pages/account/components/account-auth-form"

export function meta() {
  return [{ title: "帐号登录 | IMSWeb" }]
}

export default function AccountLoginPage() {
  return <AccountAuthForm mode="login" />
}
