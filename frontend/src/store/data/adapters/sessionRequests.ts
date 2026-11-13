import { AuthApi, UsersApi, type Configuration, type DtoLoginRequest, type DtoChangePasswordRequest } from '@/api'
import type { AxiosRequestConfig } from 'axios'

// Secret-bearing operations keep the session boundary and never use business commands.
export const sessionRequests = {
  login: (body: DtoLoginRequest, configuration: Configuration) => new AuthApi(configuration).authLoginPost(body),
  refresh: (configuration: Configuration) => new AuthApi(configuration).authRefreshPost(),
  logout: (configuration: Configuration) => new AuthApi(configuration).authLogoutPost(),
  changePassword: (body: DtoChangePasswordRequest, options: AxiosRequestConfig, configuration: Configuration) => new UsersApi(configuration).userChangePasswordPost(body, options),
  resetPassword: (id: number, options: AxiosRequestConfig, configuration: Configuration) => new UsersApi(configuration).userIdResetPasswordPost(id, options),
}
