import * as Listr from 'listr'
import {ListrTask} from 'listr'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as JSONStream from 'JSONStream'
import { Transform, Stream } from 'stream'
import chalk from 'chalk'

import { pipeIt } from './utils';
import { FilterStream } from './filter';
import { TransformStream } from './transform';
import { IEntry, IContentType, IAsset } from './model';
import { CdnSource } from './cdn_source';
import { Publisher } from './publisher';
import { Client } from './client';
import { ValidatorStream } from './validator';
import { EntryAggregator } from './entry_aggregator';

export interface ITransformArgs {
  source: string
  accessToken?: string,
  filter?: string
  raw?: boolean,
  contentType?: string
  query?: string,
  transform: string
  output?: string[]
  validate?: boolean
  draft?: boolean
  verbose?: boolean
  quiet?: boolean
  publish?: boolean | 'force'
}

type ContentTypeMap = { [id: string]: IContentType }

export default async function Run(args: ITransformArgs): Promise<void> {
  const tasks: Array<ListrTask> = []
  const clients: { [space: string]: Client } = {}
  const errorMessages: string[] = []

  const context = {
  }

  try {
    // aggregate all the entries, using the client to hit the source space if we need to
    const entryAggregator = new EntryAggregator({})

    const contentTypeMap: ContentTypeMap = {}
    let contentTypeGetter = async (id: string) => contentTypeMap[id]
    
    if (args.source == '-') {
      const stream = process.stdin
        .pipe(JSONStream.parse(args.raw ? undefined : '..*'))

      parseInto(contentTypeMap, stream)

      tasks.push({
        title: `Parse stdin${args.raw ? ' (raw mode)' : ''}`,
        task: pipeIt(
          stream
            .pipe(FilterStream(isProcessable))
            .pipe(entryAggregator)
        )
      })
    } else {
      try {
        await fs.access(args.source, fs.constants.R_OK)
        const stream = fs.createReadStream(args.source)
          .pipe(JSONStream.parse(args.raw ? undefined : '..*'))

        parseInto(contentTypeMap, stream)

        tasks.push({
          title: `Parse file ${args.source}${args.raw ? ' (raw mode)' : ''}`,
          task: pipeIt(
            stream
              .pipe(FilterStream(isProcessable))
              .pipe(entryAggregator)
          )
        })
      } catch {
      }
    }

    if (tasks.length == 0) {
      let client = getClient(args.source)
      let cdnClient = client
      if (!args.draft) {
        // use the public CDN client to source entries.
        cdnClient = await client.getCdnClient()
      }

      const source = new CdnSource({ client: cdnClient })
      entryAggregator.client = cdnClient
      contentTypeGetter = async (id: string) => {
        if (contentTypeMap[id]) {
          return contentTypeMap[id]
        }
        const resp = await client.get(`/content_types/${id}`)
        if (resp.statusCode != 200) {
          throw new Error(`${resp.statusCode} getting content type ${id}:\n  ${resp.body}`)
        }
        return contentTypeMap[id] = JSON.parse(resp.body)
      }

      tasks.push({
        title: `Download from space ${args.source}`,
        task: pipeIt(
          source.stream(args.contentType, args.query)
            .pipe(FilterStream(isProcessable))
            .pipe(entryAggregator)
        )
      })
    }

    if (args.filter) {
      tasks.push({
        title: 'filter stream',
        task: pipeIt(FilterStream(args.filter))
      })
    }

    if (args.transform && args.transform != '') {
      tasks.push({
        title: 'transform stream',
        task: pipeIt(new TransformStream(args.transform, contentTypeGetter, args.verbose))
      })
    }

    if (args.validate) {
      // if we have a client, limit to 4 concurrent entry fetches.  Otherwise
      // allow as many concurrent fetches as we have available memory, so that
      // we can wait for linked entries to come across the stream.
      // We have a 10 second timeout on fetching entries, which should be enough to
      // safely process an incoming stream no matter how big.
      const maxConcurrentEntries = clients[args.source] ? 4 : Number.MAX_SAFE_INTEGER
      const validator = new ValidatorStream({ 
        contentTypeGetter,
        entryInfoGetter: (id) => entryAggregator.getEntryInfo(id),
        maxConcurrentEntries
      })
      validator.on('invalid', (entry: IEntry, errors: string[]) => {
        const msg = chalk.red(`${entry.sys.id} is invalid:\n`) + `  ${errors.join('\n  ')}\n  https://app.contentful.com/spaces/${entry.sys.space.sys.id}/entries/${entry.sys.id}`
        errorMessages.push(msg)
      })

      tasks.push({
        title: 'validate stream',
        task: pipeIt(validator)
      })
    }

    if (args.raw && args.output.indexOf('-') < 0) {
      args.output.push('-')
    }

    args.output.forEach((o) => {
      if (o == '-') {
        tasks.push({
          title: 'write to stdout',
          task: stringifyTo(process.stdout, true)
        })
        // listr logs to stdout
        args.quiet = true
      } else if (path.extname(o) != '') {
        tasks.push({
          title: `write to file ${o}`,
          task: stringifyTo(fs.createWriteStream(o))
        })
      } else {
        // it's a space ID.  TODO: prompt for confirmation.
        const publisher = new Publisher({ client: getClient(o), publish: args.publish })
        tasks.push({
          title: `Reupload to space ${o}`,
          task: pipeIt(publisher, true)
        })
      }
    })
    
    await new Listr(tasks, 
      {
        concurrent: true,
        renderer: (args.quiet || args.verbose) ? 'silent' : 'default'
      })
      .run(context)
  } finally {
    await Promise.all(Object.keys(clients).map(space => 
      clients[space].cleanup()
    ))
  }

  if (args.verbose) {
    Object.keys(clients).forEach(space => {
      const stats = clients[space].getStats()
      console.log(chalk.gray(`${space}: ${stats.requests} total requests, rate limited ${stats.rateLimits} times, maximum request queue size of ${stats.maxQueueSize}`))
    })
  }
  errorMessages.forEach(msg => console.error(msg))

  function getClient(source: string): Client {
    let client = clients[source]
    if (client) {
      return client
    }
    const [spaceId, environment] = source.split('/')
    return clients[source] = new Client({
      spaceId,
      environment,
      accessToken: args.accessToken,
      verbose: args.verbose
    })
  }

  function stringifyTo(stream: NodeJS.WritableStream, isStdout?: boolean): (ctx: any, task: Listr.ListrTaskWrapper) => Promise<void> {
    return (ctx, task) => {
      const stringified =
        args.raw ?
          JSONStream.stringify(false) :
          JSONStream.stringify('{\n  "entries": [\n    ', ',\n    ', '\n  ]\n}\n')

      const ret = new Promise<void>((resolve, reject) => {
        let eventSource = stream
        if (isStdout) {
          // stdout doesn't have a close event, so listen to the jsonstream
          eventSource = stringified
        }
        eventSource.on('finish', () => {
          task.title += ` (${Math.round(bytes)} kb)`
          resolve()
        })
        eventSource.on('end', () => {
          task.title += ` (${Math.round(bytes)} kb)`
          resolve()
        })
        eventSource.on('error', (err) => {
          console.error('stream error!', err)
          reject(new Error(err))
        })
      })
      ctx.stream.pipe(stringified).pipe(stream)

      let bytes = 0.0
      stringified.on('data', (chunk) => {
        bytes += chunk.length / 1024.0;
        task.output = `wrote #${Math.round(bytes)} kb`
      })

      return ret
    }
  }

  function isProcessable(e: any): e is IEntry | IAsset {
    if (!e.sys){
      return false
    }
    if (e.sys.type != 'Entry' && e.sys.type != 'Asset') {
      return false
    }
    if (!args.draft && !e.sys.revision && !e.sys.publishedAt) {
      return false
    }
    return true
  }
}

function parseInto(contentTypes: ContentTypeMap, jsonStream: NodeJS.ReadableStream): void {
  jsonStream.on('data', (ct) => {
    if (isContentType(ct)) {
      contentTypes[ct.sys.id] = ct
    }
  })
}

function isContentType(json: any): json is IContentType {
  return json.sys && json.sys.type == 'ContentType'
}