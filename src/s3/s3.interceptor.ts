import {
  CallHandler,
  ExecutionContext,
  Inject,
  mixin,
  NestInterceptor,
  Optional,
  Type,
} from "@nestjs/common";
import multer from "multer";
import { Observable } from "rxjs";
import { MULTER_MODULE_OPTIONS } from "@nestjs/platform-express/multer/files.constants";
import { MulterModuleOptions } from "@nestjs/platform-express/multer/interfaces";
import { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface";
import { transformException } from "@nestjs/platform-express/multer/multer/multer.utils";
import { S3Service } from "./s3.service";
import { Request } from "express";

export function S3Interceptor(
  uploadPath: (request: Request, file: Express.Multer.File) => string,
  fieldName = "file",
  localOptions?: MulterOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    protected multer: multer.Multer;

    constructor(
      @Optional()
      @Inject(MULTER_MODULE_OPTIONS)
      options: MulterModuleOptions = {},
      private readonly s3: S3Service,
    ) {
      this.multer = multer({
        storage: this.s3.multerStorage(uploadPath),
        ...options,
        ...localOptions,
        dest: undefined,
      });
    }

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<any>> {
      const ctx = context.switchToHttp();

      await new Promise<void>((resolve, reject) =>
        this.multer.single(fieldName)(
          ctx.getRequest(),
          ctx.getResponse(),
          (err: any) => {
            if (err) {
              const error = transformException(err);
              return reject(error);
            }
            resolve();
          },
        ),
      );
      return next.handle();
    }
  }

  return mixin(MixinInterceptor);
}
