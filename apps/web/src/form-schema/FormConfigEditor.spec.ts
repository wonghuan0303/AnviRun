import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ElementPlus from 'element-plus';
import type { FormConfigIssue, FormSchema } from '@buildplatform/contracts';

import FormConfigEditor from './FormConfigEditor.vue';

const schema: FormSchema = [
  { type: 'input', name: 'name', label: '名称', defaultValue: '默认名称' },
  { type: 'textarea', name: 'summary', label: '说明' },
  { type: 'number', name: 'count', label: '数量', defaultValue: 2 },
  {
    type: 'select',
    name: 'target',
    label: '目标',
    options: [{ label: '开发', value: 'dev' }],
  },
  {
    type: 'radio',
    name: 'channel',
    label: '渠道',
    options: [{ label: '稳定', value: 'stable' }],
  },
  {
    type: 'checkbox',
    name: 'features',
    label: '特性',
    options: [{ label: '缓存', value: 'cache' }],
  },
  { type: 'switch', name: 'enabled', label: '启用' },
  { type: 'date', name: 'releaseDate', label: '发布日期' },
  { type: 'password', name: 'secret', label: '密钥', sensitive: true },
];

const global = { plugins: [ElementPlus] };

describe('FormConfigEditor', () => {
  it('renders every whitelisted control explicitly and uses defaults', async () => {
    const wrapper = mount(FormConfigEditor, {
      props: { schema, modelValue: {} },
      global,
    });
    await nextTick();

    for (const label of [
      '名称',
      '说明',
      '数量',
      '目标',
      '渠道',
      '特性',
      '启用',
      '发布日期',
      '密钥',
    ]) {
      expect(wrapper.text()).toContain(label);
    }
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('默认名称');
  });

  it('shows local validation issues once and keeps external issues visible', async () => {
    const issue: FormConfigIssue = {
      code: 'FIELD_REQUIRED',
      message: '必填字段 name 未提供值',
      path: ['name'],
      pointer: '/name',
      fieldName: 'name',
      expected: 'string',
      actual: 'undefined',
    };
    const wrapper = mount(FormConfigEditor, {
      props: {
        schema: [{ type: 'input', name: 'name', label: '名称', required: true }],
        modelValue: {},
        externalIssues: [issue],
      },
      global,
    });
    await nextTick();
    expect((wrapper.text().match(/必填字段 name 未提供值/g) ?? []).length).toBe(1);
    const validationCount = wrapper.emitted('validation')?.length ?? 0;
    await wrapper.setProps({ externalIssues: [issue] });
    await nextTick();
    await nextTick();
    expect(wrapper.emitted('validation')?.length ?? 0).toBe(validationCount);
    expect(wrapper.text()).toContain('必填字段 name 未提供值');
  });

  it('emits a typed model update when a field is edited', async () => {
    const wrapper = mount(FormConfigEditor, {
      props: { schema: [{ type: 'input', name: 'name', label: '名称' }], modelValue: {} },
      global,
    });
    await wrapper.find('input').setValue('新名称');
    await nextTick();

    const updates = wrapper.emitted('update:modelValue');
    expect(updates?.at(-1)?.[0]).toEqual({ name: '新名称' });
    expect(wrapper.emitted('field-change')?.at(-1)?.[0]).toBe('name');
  });
});
