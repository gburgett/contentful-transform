import { expect } from 'chai'
import * as nock from 'nock'
import { Client } from './client';

const responseHeaders = {
  'content-type': 'application/vnd.contentful.delivery.v1+json'
}

describe('client', () => {

  describe('get', () => {
    it('gets from master if no environment', async () => {
      const instance = new Client({accessToken: 'test123', spaceId: 'testspace'})

      nock('https://cdn.contentful.com')
        .get('/spaces/testspace/entries')
        .reply(200, {
          "sys": { "type": "Array" },
          "skip": 0,
          "limit": 0,
          "total": 0,
          "items": []
        },
        responseHeaders)

      //act
      const got = await instance.get('/entries')

      // assert
      expect(got.statusCode).to.equal(200)
    })

    it('gets from environment when givne', async () => {
      const instance = new Client({
        accessToken: 'test123',
        spaceId: 'testspace',
        environment: 'testenv'
      })

      nock('https://cdn.contentful.com')
        .get('/spaces/testspace/environments/testenv/entries')
        .reply(200, {
          "sys": { "type": "Array" },
          "skip": 0,
          "limit": 0,
          "total": 0,
          "items": []
        },
        responseHeaders)

      //act
      const got = await instance.get('/entries')

      // assert
      expect(got.statusCode).to.equal(200)
    })
  })

  describe('getCdnClient', () => {
    it('returns itself when its already a CDN client', async () => {
      const instance = new Client({accessToken: 'test123', spaceId: 'testspace'})

      // expectation - no requests to api.contentful.com
      nock('https://api.contentful.com')

      // act
      const client = await instance.getCdnClient()

      // assert
      expect(client).to.equal(instance)
    })

    it('creates a new CDN api key', async () => {
      const instance = new Client({
        accessToken: 'CFPAT-1234',
        spaceId: 'testspace'
      })

      nock('https://api.contentful.com')
        .post('/spaces/testspace/api_keys',
        {
          "name": "contentful-transform temporary CDN key",
          "environments": [
            {
              "sys": {
                "type": "Link",
                "linkType": "Environment",
                "id": "master"
              }
            }
          ]
        },
        {
          reqheaders: {
            'content-type': 'application/vnd.contentful.management.v1+json',
            authorization: 'Bearer CFPAT-1234'
          }
        })
        .reply(201, {
          "sys": {
            "type": "ApiKey",
            "id": "exampleapikey",
            "version": 1,
            "space": {
              "sys": {
                "type": "Link",
                "linkType": "Space",
                "id": "yadj1kx9rmg0"
              }
            },
            "createdAt": "2015-05-18T11:29:46.809Z",
            "createdBy": {
              "sys": {
                "type": "Link",
                "linkType": "User",
                "id": "7BslKh9TdKGOK41VmLDjFZ"
              }
            },
            "updatedAt": "2015-05-18T11:29:46.809Z",
            "updatedBy": {
              "sys": {
                "type": "Link",
                "linkType": "User",
                "id": "4FLrUHftHW3v2BLi9fzfjU"
              }
            }
          },
          "name": "Example API Key",
          "description": null,
          "accessToken": "b4c0n73n7fu1",
          "environments": [
            {
              "sys": {
                "type": "Link",
                "linkType": "Environment",
                "id": "staging"
              }
            }
          ],
          "preview_api_key": {
            "sys": {
              "type": "Link",
              "linkType": "PreviewApiKey",
              "id": "1Mx3FqXX5XCJDtNpVW4BZI"
            }
          }
        })
      nock('https://cdn.contentful.com')
        .get('/spaces/testspace/content_types?limit=1')
        .reply(401)
      nock('https://cdn.contentful.com')
        .get('/spaces/testspace/content_types?limit=1')
        .reply(200)

      // act
      const client = await instance.getCdnClient()

      // assert
      expect(client).to.not.equal(instance)
      expect(client.config.host).to.equal('https://cdn.contentful.com')
      expect(client.config.accessToken).to.equal('b4c0n73n7fu1')
      expect((instance as any).keys).to.include('exampleapikey')
    })

    it('raises error on auth failure', async () => {

      const instance = new Client({
        accessToken: 'CFPAT-1234',
        spaceId: 'testspace'
      })

      // expectation - no requests to api.contentful.com
      nock('https://api.contentful.com')
        .post('/spaces/testspace/api_keys',
        () => true,
        {
          reqheaders: {
            'content-type': 'application/vnd.contentful.management.v1+json',
            authorization: 'Bearer CFPAT-badbad'
          }
        })
        .reply(401, {"requestId":"1234","message":"The access token you sent could not be found or is invalid.","sys":{"type":"Error","id":"AccessTokenInvalid"}})

      // act
      try {
        const client = await instance.getCdnClient()
        expect.fail(null, null, 'Should have raised an error')
      } catch(e) {
        //expected
      }
    })
  })

  describe('cleanup', () => {
    it('does nothing if no keys were generated', async () => {
      const instance = new Client({accessToken: 'test123', spaceId: 'testspace'})

      // expectation - no requests to api.contentful.com
      nock('https://api.contentful.com')

      // act
      await instance.cleanup()
    })

    it('deletes a generated key', async () => {
      const instance = new Client({
        accessToken: 'CFPAT-1234',
        spaceId: 'testspace'
      })
      { (<any>instance).keys.push('test123') }

      // expectation
      const scope = nock('https://api.contentful.com')
        .delete('/spaces/testspace/api_keys/test123', 
          () => true,
          {
            reqheaders: {
              authorization: 'Bearer CFPAT-1234'
            }
          }
        )
        .reply(204)

      // act
      await instance.cleanup()

      // assert
      if (!scope.isDone()) {
        throw new Error(scope.pendingMocks().join(','))
      }
    })
  })
})