import {
  IApiSendFriendMessage,
  IApiSendGroupMessage,
  ICallbacks,
  IFriendMessage,
  IGroupMessage,
  IMahiroInitWithSimple,
  IMahiroInitWithWs,
  IMahiroOpts,
  IOnFriendMessage,
  IOnGroupMessage,
  CancelListener,
  IMahiroAdvancedOptions,
  DEFAULT_ADANCED_OPTIONS,
  DEFAULT_NETWORK,
  INodeServerOpts,
  DEFAULT_NODE_SERVER,
  SERVER_ROUTES,
  apiSchema,
} from './interface'
import { z } from 'zod'
import { consola } from 'consola'
import WebSocket from 'ws'
import axios from 'axios'
import {
  EFuncName,
  ESendCmd,
  ISendParams,
  ISendMsg,
  ISendMsgResponse,
  EToType,
} from '../send/interface'
import qs from 'qs'
import { parse } from 'url'
import {
  EC2cCmd,
  EFromType,
  EMsgEvent,
  EMsgType,
  IMsg,
} from '../received/interface'
import chalk from 'mahiro/compiled/chalk'
import figlet from 'figlet'
import express from 'express'
import cors from 'cors'
import { removeNull } from '../utils/removeNULL'

export class Mahiro {
  ws!: string
  url!: string
  qq!: number
  logger = consola

  // ws instance
  wsIns!: WebSocket
  wsRetrying = false
  wsConnected = false

  advancedOptions!: Required<IMahiroAdvancedOptions>

  app!: express.Express
  nodeServer!: Required<INodeServerOpts>
  pythonServerCannotConnect = false

  callback: ICallbacks = {
    onGroupMessage: [],
    onFreindMessage: [],
  }

  constructor(opts: IMahiroOpts) {
    this.printLogo()
    this.checkInitOpts(opts)
    this.initUrl()
    this.connect()
    this.startNodeServer()
  }

  private printLogo() {
    const fonts = figlet.fontsSync()
    const font = fonts.includes('Isometric3') ? 'Isometric3' : 'Ghost'
    const text = figlet.textSync('Mahiro', {
      font,
    })
    console.log(chalk.cyan(text))
    console.log()
  }

  private initUrl() {
    const parsed = parse(this.ws)
    this.url = `http://${parsed.hostname}:${parsed.port}`
  }

  private checkInitOpts(opts: IMahiroOpts) {
    const sharedSchema = {
      qq: z.number(),
      advancedOptions: z
        .object({
          ignoreMyself: z
            .boolean()
            .default(DEFAULT_ADANCED_OPTIONS.ignoreMyself),
        })
        .default(DEFAULT_ADANCED_OPTIONS),
      nodeServer: z
        .object({
          port: z.number().default(DEFAULT_NODE_SERVER.port),
          pythonPort: z.number().default(DEFAULT_NODE_SERVER.pythonPort),
        })
        .default(DEFAULT_NODE_SERVER),
    }
    const schema = z.union([
      z.object({
        host: z.string().default(DEFAULT_NETWORK.host),
        port: z.number().default(DEFAULT_NETWORK.port),
        ...sharedSchema,
      }),
      z.object({
        ws: z.string().startsWith('ws://'),
        ...sharedSchema,
      }),
    ])

    const result = schema.parse(opts)
    // qq
    this.qq = result.qq
    // advancedOptions
    this.advancedOptions =
      result.advancedOptions as Required<IMahiroAdvancedOptions>
    this.logger.debug('Advanced options: ', this.advancedOptions)
    // nodeServer
    this.nodeServer = result.nodeServer as Required<INodeServerOpts>
    this.logger.debug('Node server options: ', this.nodeServer)

    // ws
    const withWs = result as IMahiroInitWithWs
    if (withWs?.ws?.length) {
      this.ws = withWs.ws
      return
    }
    const withSimple = result as IMahiroInitWithSimple
    if (withSimple?.host?.length && withSimple?.port) {
      this.ws = `ws://${withSimple.host}:${withSimple.port}/ws`
      return
    }

    throw new Error('Invalid opts')
  }

  private connect() {
    this.wsRetrying = false
    this.logger.info('Try connect...')
    const ws: WebSocket = this.wsIns = new WebSocket(this.ws)

    const retryConnect = (time: number = 5 * 1e3) => {
      if (this.wsRetrying) {
        return
      }
      this.logger.warn('Retry connect..., wait ', time, 'ms')
      this.wsRetrying = true
      setTimeout(() => {
        this.connect()
      }, time)
    }

    ws.on('error', (err) => {
      this.logger.error(`WS Error: `, err)
    })

    ws.on('open', () => {
      this.logger.success('WS Connected', this.ws)
      this.wsConnected = true
    })

    ws.on('message', (data: Buffer) => {
      const str = data.toString()
      this.logger.debug('WS Message: ', str)
      try {
        const json = JSON.parse(str)
        this.triggerListener(json)
      } catch (e) {
        this.logger.error('WS message parse error: ', e)
      }
    })

    ws.on('close', () => {
      this.logger.warn('WS Closed')
      this.wsConnected = false
      retryConnect()
    })
  }

  private triggerListener(json: IMsg) {
    const { CurrentPacket, CurrentQQ } = json
    if (CurrentQQ !== this.qq) {
      this.logger.error('CurrentQQ not match: ', CurrentQQ)
      return
    }
    const { EventData, EventName } = CurrentPacket
    if (EventName !== EMsgEvent.ON_EVENT_QQNT_NEW_MSG) {
      this.logger.error('Unsupport event name: ', EventName)
      return
    }
    const { MsgHead, MsgBody: _MsgBody } = EventData
    // remove msg body null value
    // because null can not match models in python
    const MsgBody = removeNull(_MsgBody)

    // debug log
    this.logger.debug(
      'Received message: ',
      `FromType: ${MsgHead?.FromType}`,
      `MsgType: ${MsgHead?.MsgType}`,
      `C2cCmd: ${MsgHead?.C2cCmd}`,
      `Content: ${MsgBody?.Content || ''}`,
    )

    const { ignoreMyself } = this.advancedOptions

    // onGroupMessage
    const isGroupMsg =
      MsgHead?.FromType === EFromType.group &&
      MsgHead?.MsgType === EMsgType.group &&
      MsgHead?.C2cCmd === EC2cCmd.group
    if (isGroupMsg) {
      const data = {
        groupId: MsgHead?.GroupInfo?.GroupCode!,
        groupName: MsgHead?.GroupInfo?.GroupName!,
        userId: MsgHead?.SenderUin,
        userNickname: MsgHead?.SenderNick || '',
        msg: MsgBody!,
      } satisfies IGroupMessage
      // ignore myself
      if (ignoreMyself && data.userId === this.qq) {
        return
      }
      // trigger callback
      this.logger.info(
        `Received ${chalk.green('group')} message: `,
        `${data?.groupName}(${data?.groupId})`,
        `${data?.userNickname}(${data?.userId})`,
      )
      this.callback.onGroupMessage.forEach((callback) => {
        callback(data, json)
      })
      return
    }

    // onFriendMessage
    const isFriendMsg =
      MsgHead?.FromType === EFromType.friends &&
      MsgHead?.MsgType === EMsgType.friends &&
      MsgHead?.C2cCmd === EC2cCmd.firends
    if (isFriendMsg) {
      const data = {
        userId: MsgHead?.SenderUin,
        userName: MsgHead?.SenderNick || '',
        msg: MsgBody!,
      } satisfies IFriendMessage
      // ignore myself
      if (ignoreMyself && data.userId === this.qq) {
        return
      }
      // trigger callback
      this.logger.info(
        `Received ${chalk.blue('friend')} message: `,
        `${data?.userName}(${data?.userId})`,
      )
      this.callback.onFreindMessage.forEach((callback) => {
        callback(data, json)
      })
      return
    }
  }

  private async sendApi(opts: {
    CgiRequest: ISendMsg['CgiRequest']
  }): Promise<ISendMsgResponse | undefined> {
    if (!this.wsConnected) {
      this.logger.error('WS not connected, send api failed')
      return
    }
    const { CgiRequest } = opts
    const params = {
      funcname: EFuncName.MagicCgiCmd,
      timeout: 10,
      qq: this.qq,
    } satisfies ISendParams
    const stringifyParams = qs.stringify(params)
    const sendMsgUrl = `${this.url}/v1/LuaApiCaller?${stringifyParams}`
    try {
      const res = await axios.post(sendMsgUrl, {
        CgiCmd: ESendCmd.send,
        CgiRequest,
      } satisfies ISendMsg)
      if (res?.data) {
        return res.data
      }
    } catch (e) {
      this.logger.error('Send api error: ', e)
    }
  }

  onGroupMessage(name: string, callback: IOnGroupMessage): CancelListener {
    this.logger.info(`Register ${chalk.green('onGroupMessage')}: `, name)
    this.callback.onGroupMessage.push(callback)
    return () => {
      this.callback.onGroupMessage.splice(
        this.callback.onGroupMessage.indexOf(callback),
        1,
      )
    }
  }

  onFriendMessage(name: string, callback: IOnFriendMessage): CancelListener {
    this.logger.info(`Register ${chalk.blue('onFriendMessage')}: `, name)
    this.callback.onFreindMessage.push(callback)
    return () => {
      this.callback.onFreindMessage.splice(
        this.callback.onFreindMessage.indexOf(callback),
        1,
      )
    }
  }

  async sendGroupMessage(data: IApiSendGroupMessage) {
    this.logger.info(
      `Send ${chalk.green('group')} message: ${data.groupId}, ${
        data?.msg?.Content?.slice(0, 10) || ''
      }...`,
    )
    const res = await this.sendApi({
      CgiRequest: {
        ToUin: data.groupId,
        ToType: EToType.group,
        ...data.msg,
      },
    })
    return res
  }

  async sendFriendMessage(data: IApiSendFriendMessage) {
    this.logger.info(
      `Send ${chalk.blue('friend')} message: ${data.userId}, ${
        data?.msg?.Content?.slice(0, 10) || ''
      }`,
    )
    const res = await this.sendApi({
      CgiRequest: {
        ToUin: data.userId,
        ToType: EToType.friends,
        ...data.msg,
      },
    })
    return res
  }

  private startNodeServer() {
    const { port } = this.nodeServer
    const app = (this.app = express())
    this.addBaseServerMiddleware()
    this.addBaseServerRoutes()
    app.listen(port, () => {
      this.logger.info(`[Node Server] start at ${chalk.magenta(port)}`)
    })
    this.registryPythonForward()
  }

  private addBaseServerMiddleware() {
    this.logger.debug('[Node Server] Add base middleware')
    const app = this.app
    app.use(express.json())
    app.use(cors())
  }

  private addBaseServerRoutes() {
    this.logger.debug('[Node Server] Add base routes')
    const app = this.app
    // recive message
    app.post(SERVER_ROUTES.recive.group, async (req, res) => {
      const json = req.body as IApiSendGroupMessage
      try {
        apiSchema.sendGroupMessage.parse(json)
        // todo: transform to api schema
        this.logger.debug(
          '[Node Server] Recive group message: ',
          JSON.stringify(json),
        )
        await this.sendGroupMessage(json)
        res.json({
          code: 200,
        })
        res.status(200)
      } catch {
        this.logger.error('[Node Server] Recive group message error: ', json)
        res.json({
          code: 500,
        })
        res.status(500)
      }
    })
    app.post(SERVER_ROUTES.recive.friend, async (req, res) => {
      const json = req.body as IApiSendFriendMessage
      try {
        apiSchema.sendFriendMessage.parse(json)
        // todo: transform to api schema
        this.logger.debug(
          '[Node Server] Recive friend message: ',
          JSON.stringify(json),
        )
        await this.sendFriendMessage(json)
        res.json({
          code: 200,
        })
        res.status(200)
      } catch {
        this.logger.error('[Node Server] Recive friend message error: ', json)
        res.json({
          code: 500,
        })
        res.status(500)
      }
    })
  }

  private async sendToPython(opts: { path: string, data: Record<string, any> }) {
    const { path, data } = opts
    const base = `http://0.0.0.0:${this.nodeServer.pythonPort}`
    this.logger.debug(`[Node Server] Python Forward - ${path}: `, data)
    const url = `${base}${path}`
    try {
      const res = await axios.post(url, data)
      if (res.status !== 200) {
        this.logger.error(`[Node Server] Python Forward - ${path} status error: `, res.status)
      }
      if (res.data?.code !== 200) {
        this.logger.error(`[Node Server] Python Forward - ${path} response code error: `, res.data?.code)
      }
      return res.data
    } catch (e) {
      if (!this.pythonServerCannotConnect) {
        // only log once
        this.logger.warn(`[Node Server] Python Forward - Failed`)
        this.pythonServerCannotConnect = true
      }
    }
  }

  private registryPythonForward() {
    const prefix = `[Node Server] Python Forward - `
    const pathWithGroup = `/recive/group`
    this.onGroupMessage(`${prefix}Group Message`, async (data) => {
      await this.sendToPython({
        path: pathWithGroup,
        data,
      })
    })
    const pathWithFriend = `/recive/friend`
    this.onFriendMessage(`${prefix}Friend Message`, async (data) => {
      await this.sendToPython({
        path: pathWithFriend,
        data,
      })
    })
  }
}
