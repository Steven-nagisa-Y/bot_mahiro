import { join } from 'path'
import { IMsg, IMsgBody } from '../received/interface'
import {
  EUploadCommandId,
  ICgiRequest,
  ISendMsg,
  ISendParams,
} from '../send/interface'
import { z } from 'zod'
import { consola } from 'consola'
import { securityCopilotInterceptor } from '../interceptors/securityCopilot'
import type { Mahiro } from './'

export interface IMahiroAdvancedOptions {
  /**
   * 是否忽略自己的消息
   * @default true
   */
  ignoreMyself?: boolean

  /**
   * mahiro 管理面板数据库路径
   * @default ${cwd}/mahiro.db
   */
  databasePath?: string

  /**
   * 发送消息拦截器
   * @default []
   */
  interceptors?: IMahiroInterceptor[]

  /**
   * 伴生bot，用于多Q场景
   * @experiment 还没测试过
   * @default []
   */
  sideQQs?: number[]

  /**
   * 启用 redis kv
   * @example 'redis://localhost:6379'
   */
  redisKV?: string
}

export type IMahiroMsgStack = Map<number, IMahiroMsgHistory[]>

export interface IMahiroMsgHistory {
  time: number
  msg: ISendMsg
}

export interface IMahiroInterceptorContext {
  params: ISendParams
  data: ISendMsg
  logger: typeof consola
  stack: readonly IMahiroMsgHistory[]
}
export type IMahiroInterceptorFunction = (
  ctx: IMahiroInterceptorContext,
) => Promise<boolean> | boolean
export type IMahiroInterceptor = string | IMahiroInterceptorFunction

export interface IMahiroInitBase {
  qq: number
  advancedOptions?: IMahiroAdvancedOptions
  nodeServer?: INodeServerOpts
}

export const DEFAULT_NETWORK = {
  host: '0.0.0.0',
  port: 8086,
}
export const DEFAULT_ADANCED_OPTIONS: Required<IMahiroAdvancedOptions> = {
  ignoreMyself: true,
  databasePath: join(process.cwd(), 'mahiro.db'),
  interceptors: [securityCopilotInterceptor],
  sideQQs: [],
  redisKV: ''
}
export interface IMahiroInitWithSimple extends IMahiroInitBase {
  /**
   * @default 0.0.0.0
   * @example 100.0.0.1
   */
  host?: string
  /**
   * @default 8086
   */
  port?: number
}

export interface IMahiroInitWithWs extends IMahiroInitBase {
  /**
   * @example ws://100.0.0.1:9000/ws
   */
  ws: `ws://${string}`
}

export type IMahiroOpts = IMahiroInitWithSimple | IMahiroInitWithWs

export interface IGroupMessageConfigs {
  availablePlugins: string[]
}

export interface IGroupMessage {
  groupId: number
  groupName: string
  userId: number
  userNickname: string
  msg: IMsgBody
  /**
   * from bot qq
   */
  qq: number
  /**
   * 高级配置，一般用于内部
   */
  configs: IGroupMessageConfigs
}

export type CancelListener = () => void
export type CallbackReturn = void | Promise<void>

export interface IOnGroupMessage {
  (useful: IGroupMessage, raw: IMsg): CallbackReturn
}

export interface IFriendMessage {
  userId: number
  userName: string
  msg: IMsgBody
  /**
   * from bot qq
   */
  qq: number
}

export interface IOnFriendMessage {
  (useful: IFriendMessage, raw: IMsg): CallbackReturn
}

export interface ICallbacks {
  onGroupMessage: Record<string, IOnGroupMessage>
  onFreindMessage: Record<string, IOnFriendMessage>
}

export type IApiMsg = Pick<ICgiRequest, 'Content' | 'AtUinLists' | 'Images'>

const msgSchema = z.object({
  Content: z.string().optional(),
  AtUinLists: z
    .array(
      z.object({
        Uin: z.number(),
        Nick: z.string().optional(),
      }),
    )
    .optional(),
  Images: z
    .array(
      z.object({
        FileId: z.number(),
        FileMd5: z.string(),
        FileSize: z.number(),
      }),
    )
    .optional(),
})

// 一些需要回传的额外信息
const pythonConfigsSchema = z.object({
  id: z.string(),
})
export const apiSchema = {
  sendGroupMessage: z.object({
    groupId: z.number(),
    msg: msgSchema,
    fastImage: z.string().optional(),
    qq: z.number(),
    configs: pythonConfigsSchema,
  }),
  sendFriendMessage: z.object({
    userId: z.number(),
    msg: msgSchema,
    fastImage: z.string().optional(),
    qq: z.number(),
    configs: pythonConfigsSchema,
  }),
} satisfies Record<string, z.ZodSchema<any>>
export interface IApiSendGroupMessage {
  groupId: number
  qq?: number
  msg?: Partial<IApiMsg>
  /**
   * 便捷字段，会被转换为 msg.Images
   * 必须传图片本地绝对路径或 url
   */
  fastImage?: string
  // todo: support voice
}

export interface IApiSendFriendMessage {
  userId: number
  qq?: number
  msg?: Partial<IApiMsg>
  /**
   * @see {@link IApiSendGroupMessage.fastImage}
   */
  fastImage?: string
}

export interface ISendApiOpts {
  CgiRequest: ICgiRequest
  qq: number
}

const getDefaultNodeServerPort = () => {
  const fallback = 8098
  const env = process.env.MAHIRO_NODE_URL
  if (env?.length) {
    const url = new URL(env)
    return parseInt(url.port, 10) || fallback
  }
  return fallback
}
const getDefaultPythonServerPort = () => {
  const env = process.env.MAHIRO_PYTHON_PORT
  if (env?.length) {
    return parseInt(env, 10)
  }
  return 8099
}
export const DEFAULT_NODE_SERVER: Required<INodeServerOpts> = {
  port: getDefaultNodeServerPort(),
  pythonPort: getDefaultPythonServerPort(),
}
export interface INodeServerOpts {
  port?: number
  pythonPort?: number
}
export const SERVER_ROUTES = {
  recive: {
    group: '/api/v1/recive/group',
    friend: '/api/v1/recive/friend',
  },
} as const

export enum EAsyncContextFrom {
  group = 'group',
  friend = 'friend',
}

export interface IAsyncContext {
  /**
   * plugin name
   */
  name: string
  qq: number
  /**
   * timestamp
   */
  time: number
  /**
   * 来源
   */
  from: EAsyncContextFrom
}
export const asyncHookUtils = {
  hash: (opts: IAsyncContext) => {
    return JSON.stringify(opts)
  },
  parse: (hash?: any) => {
    if (hash?.length) {
      try {
        return JSON.parse(hash) as IAsyncContext
      } catch {}
    }
  },
}

export interface IMahiroUploadFileOpts {
  commandId: EUploadCommandId
  qq: number
  /**
   * 可以是 url 或者本地文件绝对路径，会自动区分
   */
  file: string
}

export interface IMahiroUse {
  (mahiro: Mahiro): Promise<void> | void
}

export interface IMiddlewares {
  group: IMahiroGroupMiddleware[]
  friend: IMahiroFriendMiddleware[]
}

export type IMahiroMiddleware<T = any> = (
  data: T,
) => (T | false) | Promise<T | false>

export type IMahiroGroupMiddleware = IMahiroMiddleware<IGroupMessage>

export type IMahiroFriendMiddleware = IMahiroMiddleware<IFriendMessage>

export enum EMiddleware {
  group = 'middleware-group',
  friend = 'middleware-friend',
}
