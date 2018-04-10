import * as yargs from 'yargs'

import Run from './main'

const argv = yargs
  .usage("$0 [options] <transform>")
  .command('transform', 'The transformation to apply')
  .alias('s', 'source').describe('source', 'The source file, or space ID to load. "-" indicates stdin.')
  .default('source', '-')
  .alias('a', 'access-token').describe('access-token', 'The contentful access token to use')
  .alias('o', 'output').describe('output', 'The output file to write to.  Default stdout.')
  .alias('c', 'content-type').describe('content-type', 'The content type to query for when loading from a space ID')
  .implies('query', 'content-type')
  .alias('q', 'query').describe('query', 'An entry filter query used when loading from a space ID')
  .alias('f', 'filter').describe('filter', 'A filtering function to apply after loading the data.')
  .alias('x', 'quiet').describe('quiet', 'Do not output task progress')
  .demandCommand(1)
  .example("cat contentful-export.json | $0 'url=url.replace(/\/$/, \"\")'", "processes the file from stdin and trims trailing slashes from URLs")
  .example("$0 -s contentful-export.json -f 'sys.contentType.sys.id==\"foo\"' '_entry.fields.new_field[\"en-US\"]=\"something new\"", "adds a new field to every entry in the given file matching the 'foo' content type")
  .argv

Run({
  source: argv.source || '-',
  accessToken: argv.accessToken || process.env['CONTENTFUL_ACCESS_TOKEN'],
  transform: argv._[0],
  filter: argv.filter,
  contentType: argv.contentType,
  query: argv.query,
  output: argv.output,
  quiet: argv.quiet
})
  .catch((err) => {
    console.error(err)
  })