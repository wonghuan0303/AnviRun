import type { FormField, FormFieldType, FormSchema } from '@anvilrun/contracts';

export const FORM_FIELD_TYPE_GUIDE: readonly {
  type: FormFieldType;
  label: string;
}[] = [
  { type: 'input', label: '单行文本' },
  { type: 'textarea', label: '多行文本' },
  { type: 'number', label: '数字' },
  { type: 'select', label: '下拉单选' },
  { type: 'radio', label: '单选按钮' },
  { type: 'checkbox', label: '多选框' },
  { type: 'switch', label: '开关' },
  { type: 'date', label: '日期' },
  { type: 'password', label: '密码' },
  { type: 'file', label: '文件上传' },
];

const FORM_SCHEMA_EXAMPLE_FIELDS = [
  {
    type: 'input',
    name: 'branchName',
    label: '分支名称',
    required: true,
    defaultValue: 'main',
    placeholder: '例如 main',
    maxLength: 100,
  },
  {
    type: 'textarea',
    name: 'releaseNotes',
    label: '发布说明',
    maxLength: 2000,
  },
  {
    type: 'number',
    name: 'parallelism',
    label: '并行数',
    defaultValue: 4,
    min: 1,
    max: 16,
    step: 1,
  },
  {
    type: 'select',
    name: 'environment',
    label: '部署环境',
    defaultValue: 'test',
    options: [
      { label: '测试环境', value: 'test' },
      { label: '生产环境', value: 'production' },
    ],
  },
  {
    type: 'radio',
    name: 'buildMode',
    label: '构建模式',
    defaultValue: 'release',
    options: [
      { label: '调试', value: 'debug' },
      { label: '发布', value: 'release' },
    ],
  },
  {
    type: 'checkbox',
    name: 'features',
    label: '可选功能',
    defaultValue: [],
    options: [
      { label: '生成源码映射', value: 'source-map' },
      { label: '生成分析报告', value: 'analyze' },
    ],
  },
  {
    type: 'switch',
    name: 'minify',
    label: '压缩产物',
    defaultValue: true,
  },
  {
    type: 'date',
    name: 'releaseDate',
    label: '发布日期',
    description: '日期值格式为 YYYY-MM-DD',
  },
  {
    type: 'password',
    name: 'registryToken',
    label: '制品库令牌',
    required: true,
    sensitive: true,
  },
  {
    type: 'file',
    name: 'packageFile',
    label: '安装包',
    required: true,
    allowedExtensions: ['.zip', '.tar.gz'],
    fileNamePattern: 'my-app-[0-9]+\\.[0-9]+\\.[0-9]+\\.(zip|tar\\.gz)',
    maxSizeBytes: 536870912,
    description: '包名示例：my-app-1.2.3.zip',
  },
] satisfies readonly FormField[];

export const FORM_SCHEMA_EXAMPLE = [
  {
    type: 'tab',
    name: 'basic',
    label: '基础配置',
    description: '常用构建参数',
    children: FORM_SCHEMA_EXAMPLE_FIELDS.slice(0, 5),
  },
  {
    type: 'tab',
    name: 'advanced',
    label: '高级配置',
    children: FORM_SCHEMA_EXAMPLE_FIELDS.slice(5),
  },
] satisfies FormSchema;

export const FORM_SCHEMA_EXAMPLE_TEXT = JSON.stringify(FORM_SCHEMA_EXAMPLE, null, 2);
