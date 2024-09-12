import { AxiosResponse } from 'axios'
import { fireErrorEvent, fireInvalidEvent, firePrefetchedEvent, fireSuccessEvent } from './events'
import { History } from './history'
import modal from './modal'
import { page as currentPage } from './page'
import { RequestParams } from './requestParams'
import { SessionStorage } from './sessionStorage'
import { ActiveVisit, ErrorBag, Errors, Page } from './types'
import { hrefToUrl, isSameUrlWithoutHash, setHashIfSameUrl } from './url'

class ResponseQueue {
  protected queue: Response[] = []
  protected processing = false

  public add(response: Response) {
    this.queue.push(response)
  }

  public async process(): Promise<void> {
    if (this.processing) {
      return Promise.resolve()
    }

    this.processing = true
    await this.processQueue()
    this.processing = false

    return Promise.resolve()
  }

  protected async processQueue(): Promise<void> {
    const nextResponse = this.queue.shift()

    if (nextResponse) {
      await nextResponse.process()
      return this.processQueue()
    }

    return Promise.resolve()
  }
}

const queue = new ResponseQueue()

export class Response {
  constructor(
    protected requestParams: RequestParams,
    protected response: AxiosResponse,
    protected originatingPage: Page,
  ) {}

  public static create(params: RequestParams, response: AxiosResponse, originatingPage: Page): Response {
    return new Response(params, response, originatingPage)
  }

  public async handlePrefetch() {
    if (currentPage.get().component === this.response.data.component) {
      this.handle()
    }
  }

  public async handle() {
    queue.add(this)
    return queue.process()
  }

  public async process() {
    if (this.requestParams.all().prefetch) {
      this.requestParams.all().prefetch = false
      this.requestParams.all().onPrefetched(this.response, this.requestParams.all())
      firePrefetchedEvent(this.response, this.requestParams.all())
      this.requestParams.all().onPrefetchResponse(this)
      return Promise.resolve()
    }

    this.requestParams.runCallbacks()

    if (!this.isInertiaResponse()) {
      return this.handleNonInertiaResponse()
    }

    History.preserveUrl = this.requestParams.all().preserveUrl

    await this.setPage()

    const errors = currentPage.get().props.errors || {}

    if (Object.keys(errors).length > 0) {
      const scopedErrors = this.getScopedErrors(errors)

      fireErrorEvent(scopedErrors)

      return this.requestParams.all().onError(scopedErrors)
    }

    fireSuccessEvent(currentPage.get())

    await this.requestParams.all().onSuccess(currentPage.get())

    History.preserveUrl = false
  }

  public mergeParams(params: ActiveVisit) {
    this.requestParams.merge(params)
  }

  protected async handleNonInertiaResponse() {
    if (this.isLocationVisit()) {
      const locationUrl = hrefToUrl(this.getHeader('x-inertia-location'))

      setHashIfSameUrl(this.requestParams.all().url, locationUrl)

      return this.locationVisit(locationUrl)
    }

    if (fireInvalidEvent(this.response)) {
      return modal.show(this.response.data)
    }
  }

  protected isInertiaResponse(): boolean {
    return this.hasHeader('x-inertia')
  }

  protected hasStatus(status: number): boolean {
    return this.response.status === status
  }

  protected getHeader(header: string): string {
    return this.response.headers[header]
  }

  protected hasHeader(header: string): boolean {
    return this.getHeader(header) !== undefined
  }

  protected isLocationVisit(): boolean {
    return this.hasStatus(409) && this.hasHeader('x-inertia-location')
  }

  /**
   * @link https://inertiajs.com/redirects#external-redirects
   */
  protected locationVisit(url: URL): boolean | void {
    try {
      SessionStorage.set(SessionStorage.locationVisitKey, {
        preserveScroll: this.requestParams.all().preserveScroll === true,
      })

      if (isSameUrlWithoutHash(window.location, url)) {
        window.location.reload()
      } else {
        window.location.href = url.href
      }
    } catch (error) {
      return false
    }
  }

  protected setPage(): Promise<void> {
    const pageResponse: Page = this.response.data

    if (!this.shouldSetPage(pageResponse)) {
      return Promise.resolve()
    }

    this.mergeProps(pageResponse)
    this.setRememberedState(pageResponse)

    this.requestParams.setPreserveOptions(pageResponse)

    pageResponse.url = History.preserveUrl ? currentPage.get().url : this.pageUrl(pageResponse)

    return currentPage.set(pageResponse, {
      replace: this.requestParams.all().replace,
      preserveScroll: this.requestParams.all().preserveScroll,
      preserveState: this.requestParams.all().preserveState,
    })
  }

  protected shouldSetPage(pageResponse: Page): boolean {
    if (!this.requestParams.all().async) {
      // If the request is sync, we should always set the page
      return true
    }

    if (this.originatingPage.component !== pageResponse.component) {
      // We originated from a component but the response re-directed us,
      // we should respect the redirection and set the page
      return true
    }

    // At this point, if the originating request component is different than the current component,
    // the user has since navigated and we should discard the response
    if (this.originatingPage.component !== currentPage.get().component) {
      return false
    }

    const originatingUrl = hrefToUrl(this.originatingPage.url)
    const currentPageUrl = hrefToUrl(currentPage.get().url)

    // We have the same component, let's double-check the URL
    // If we're no longer on the same path name (e.g. /users/1 -> /users/2), we should not set the page
    return originatingUrl.origin === currentPageUrl.origin && originatingUrl.pathname === currentPageUrl.pathname
  }

  protected pageUrl(pageResponse: Page) {
    const responseUrl = hrefToUrl(pageResponse.url)

    setHashIfSameUrl(this.requestParams.all().url, responseUrl)

    return responseUrl.href
  }

  protected mergeProps(pageResponse: Page): void {
    if (this.requestParams.isPartial() && pageResponse.component === currentPage.get().component) {
      const propsToMerge = pageResponse.mergeProps || []

      propsToMerge.forEach((prop) => {
        const incomingProp = pageResponse.props[prop]

        if (Array.isArray(incomingProp)) {
          pageResponse.props[prop] = [...((currentPage.get().props[prop] || []) as any[]), ...incomingProp]
        } else if (typeof incomingProp === 'object') {
          pageResponse.props[prop] = {
            ...((currentPage.get().props[prop] || []) as Record<string, any>),
            ...incomingProp,
          }
        }
      })

      pageResponse.props = { ...currentPage.get().props, ...pageResponse.props }
    }
  }

  protected setRememberedState(pageResponse: Page): void {
    if (
      this.requestParams.all().preserveState &&
      History.getState(History.rememberedState) &&
      pageResponse.component === currentPage.get().component
    ) {
      pageResponse.rememberedState = History.getState(History.rememberedState)
    }
  }

  protected getScopedErrors(errors: Errors & ErrorBag): Errors {
    if (!this.requestParams.all().errorBag) {
      return errors
    }

    return errors[this.requestParams.all().errorBag || ''] || {}
  }
}
