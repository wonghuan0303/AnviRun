import { defineComponent, nextTick, ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import type { FormSchemaIssue } from '@anvilrun/contracts';

import FormSchemaEditor from './FormSchemaEditor.vue';

const serverIssue: FormSchemaIssue = {
  code: 'FIELD_TYPE_UNKNOWN',
  path: [0, 'type'],
  pointer: '/0/type',
  message: 'Server 返回的控件类型错误',
  fieldIndex: 0,
  fieldName: 'branch',
  property: 'type',
};

const global = { plugins: [ElementPlus] };

describe('FormSchemaEditor', () => {
  it('shows syntax errors and a safe preview for valid JSON', async () => {
    const wrapper = mount(FormSchemaEditor, {
      props: { modelValue: '[]' },
      global,
    });

    const textarea = wrapper.find('textarea');
    await textarea.setValue('{"type":');
    await nextTick();
    expect(wrapper.text()).toContain('JSON 语法错误');

    await textarea.setValue('[{"type":"input","name":"branch","label":"分支"}]');
    await nextTick();
    expect(wrapper.text()).toContain('动态预览');
    expect(wrapper.text()).toContain('分支');
  });

  it('displays one copy of a local validator issue', async () => {
    const wrapper = mount(FormSchemaEditor, {
      props: { modelValue: '[{"type":"unknown","name":"x","label":"X"}]' },
      global,
    });

    await nextTick();
    expect(wrapper.text()).toContain('formSchema 协议校验失败');
    expect((wrapper.text().match(/\/0\/type/g) ?? []).length).toBe(1);
  });

  it('keeps external Server issues visible and does not emit validation when only external issues change', async () => {
    const wrapper = mount(FormSchemaEditor, {
      props: { modelValue: '[]', externalIssues: [serverIssue] },
      global,
    });
    await nextTick();

    const validationCount = wrapper.emitted('validation')?.length ?? 0;
    expect(wrapper.text()).toContain(serverIssue.message);
    expect(wrapper.text()).not.toContain('动态预览');

    await wrapper.setProps({ externalIssues: [serverIssue] });
    await nextTick();
    expect(wrapper.emitted('validation')?.length ?? 0).toBe(validationCount);
    expect(wrapper.text()).toContain(serverIssue.message);

    await wrapper.find('textarea').setValue('[]');
    await nextTick();
    expect(wrapper.text()).toContain(serverIssue.message);
  });

  it('emits schema-change so the parent can clear Server issues after editing and restore preview', async () => {
    const host = defineComponent({
      components: { FormSchemaEditor },
      setup() {
        const text = ref('[]');
        const external = ref<readonly FormSchemaIssue[]>([serverIssue]);
        return { text, external };
      },
      template:
        '<FormSchemaEditor v-model="text" :external-issues="external" @schema-change="external = []" />',
    });
    const wrapper = mount(host, { global });
    await nextTick();

    expect(wrapper.text()).toContain(serverIssue.message);
    expect(wrapper.text()).not.toContain('动态预览');

    await wrapper.find('textarea').setValue('[{"type":"input","name":"branch","label":"分支"}]');
    await nextTick();

    expect(wrapper.text()).not.toContain(serverIssue.message);
    expect(wrapper.text()).toContain('动态预览');
  });
});
