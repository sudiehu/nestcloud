import {
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ILoadbalance } from '@nestcloud/common';
import { Interceptor } from './interfaces/interceptor.interface';
import { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import axios from 'axios';
import * as LbModule from '@nestcloud/loadbalance';
import { HttpOptions } from './interfaces/http-options.interface';
import { AXIOS_INSTANCE_PROVIDER, HTTP_OPTIONS_PROVIDER } from './http.constants';
import { Brakes, Fallback } from '@nestcloud/brakes';

@Injectable()
export class HttpClient {
    private lb: ILoadbalance;
    private brakes: Brakes;
    private fallback: Fallback;
    private interceptors: Interceptor[];
    private readonly service: string;

    constructor(
        @Inject(AXIOS_INSTANCE_PROVIDER) private readonly http: AxiosInstance,
        @Inject(HTTP_OPTIONS_PROVIDER) private readonly options: HttpOptions,
    ) {
        this.service = options.service;
    }

    create(options: HttpOptions = {}) {
        return new HttpClient(axios.create({ ...options } as AxiosRequestConfig), options);
    }

    useLb(lb: ILoadbalance) {
        this.lb = lb;
        return this;
    }

    useInterceptors(...interceptors: Interceptor[]) {
        this.interceptors = interceptors;
        this.registerInterceptors();
        return this;
    }

    useBrakes(brakes: Brakes, fallback?: Fallback) {
        this.brakes = brakes;
        this.fallback = fallback;
    }

    public async get(url: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse | any> {
        return this.request({ method: 'get', url, ...config });
    }

    public async delete(url: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse | any> {
        return this.request({ method: 'delete', url, ...config });
    }

    public async head(url: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse | any> {
        return this.request({ method: 'head', url, ...config });
    }

    public async post(url: string, data?: any, config: AxiosRequestConfig = {}): Promise<AxiosResponse | any> {
        return this.request({ method: 'post', url, data, ...config });
    }

    public async put(url: string, data?: any, config: AxiosRequestConfig = {}): Promise<AxiosResponse | any> {
        return this.request({ method: 'put', url, data, ...config });
    }

    public async patch(url: string, data?: any, config: AxiosRequestConfig = {}): Promise<AxiosResponse | any> {
        return this.request({ method: 'patch', url, data, ...config });
    }

    public async request(options: AxiosRequestConfig): Promise<AxiosResponse | any> {
        if (this.brakes) {
            return this.requestWithBrakes(options);
        }

        return this.doRequest(options);
    }

    private async requestWithBrakes(options: AxiosRequestConfig): Promise<AxiosResponse | any> {
        let e: HttpException = null;
        const ref = this.brakes.slave(this.service, this.fallback, async () => {
            try {
                return await this.doRequest(options);
            } catch (error) {
                e = error as HttpException;
                if (error instanceof HttpException) {
                    return;
                }

                throw e;
            }
        });
        const response = await ref(options);

        if (e) {
            throw e;
        }
        return response;
    }

    public async doRequest(options: AxiosRequestConfig): Promise<AxiosResponse | any> {
        let response: AxiosResponse;
        if (this.service && this.lb) {
            const module: typeof LbModule = require('@nestcloud/loadbalance');
            const server = this.lb.choose(this.service);
            if (!server) {
                throw new InternalServerErrorException(`No available server can handle this request`);
            }
            response = await new module.HttpDelegate(server).send(this.http, options);
        } else if (this.service) {
            if (options.url && options.url.charAt(0) !== '/') {
                options.url = '/' + options.url;
            }
            options.url = `http://${this.service}${options.url}`;
            response = await this.send(options);
        } else {
            response = await this.send(options);
        }

        return response;
    }

    private registerInterceptors() {
        if (this.interceptors) {
            this.interceptors.forEach(interceptor => {
                this.http.interceptors.request.use(
                    interceptor.onRequest ? interceptor.onRequest.bind(interceptor) : undefined,
                    interceptor.onRequestError ? interceptor.onRequestError.bind(interceptor) : undefined,
                );
                this.http.interceptors.response.use(
                    interceptor.onResponse ? interceptor.onResponse.bind(interceptor) : undefined,
                    interceptor.onResponseError ? interceptor.onResponseError.bind(interceptor) : undefined,
                );
            });
        }
    }

    private async send(config: AxiosRequestConfig): Promise<AxiosResponse> {
        try {
            return await this.http.request(config);
        } catch (e) {
            const error = e as AxiosError;
            if (error.response) {
                throw new HttpException(error.response.data, error.response.status);
            }
            if (error.request) {
                throw new HttpException(error.message, 400);
            }
            throw new ServiceUnavailableException(error.message);
        }
    }
}
