/**
 * 项目配置值类型。
 *
 * 用户按表单模板填写后保存在 `Project.config`，任务创建时复制一份到 `BuildTask.config`，
 * 最终由 Agent 写入源码根目录的 `platform.config.json`（产品设计 6.3）。
 */

import type { FormFieldOptionValue } from './field-types';

/**
 * 单个配置项的值。
 *
 * 与控件的对应关系：
 * - `input` / `textarea` / `date` / `password` → `string`
 * - `number` → `number`
 * - `switch` → `boolean`
 * - `select` / `radio` → `string | number`
 * - `checkbox` → `(string | number)[]`
 *
 * `null` 表示可选字段未填写且没有默认值。
 */
export type FormFieldValue = string | number | boolean | readonly FormFieldOptionValue[] | null;

/**
 * 一份完整的项目配置。
 *
 * 键集合必须是模板当前声明的 `name` 的子集；空模板对应 `{}`（产品设计 6.3）。
 */
export type FormConfigValues = Readonly<Record<string, FormFieldValue>>;
