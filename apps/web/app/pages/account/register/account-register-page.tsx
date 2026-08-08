import { AccountAuthForm } from "~/pages/account/components/account-auth-form"

export function meta() {
  return [{ title: "帐号注册 | IMSWeb" }]
}

export default function AccountRegisterPage() {
  return <AccountAuthForm mode="register" />
}
