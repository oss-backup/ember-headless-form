import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { assert, warn } from '@ember/debug';
import { on } from '@ember/modifier';
import { action } from '@ember/object';
import { waitFor } from '@ember/test-waiters';

import { modifier } from 'ember-modifier';
import { TrackedObject } from 'tracked-built-ins';

import FieldComponent from './-private/field';
import { mergeErrorRecord } from './-private/utils';

import type { HeadlessFormFieldComponentSignature } from './-private/field';
import type {
  ErrorRecord,
  FieldRegistrationData,
  FieldValidateCallback,
  FormData,
  FormKey,
  FormValidateCallback,
  UserData,
  ValidationError,
} from './-private/types';
import type {
  ComponentLike,
  ModifierLike,
  WithBoundArgs,
} from '@glint/template';

type ValidateOn = 'change' | 'blur' | 'submit';

export interface HeadlessFormComponentSignature<DATA extends UserData> {
  Element: HTMLFormElement;
  Args: {
    data?: DATA;
    validateOn?: ValidateOn;
    revalidateOn?: ValidateOn;
    validate?: FormValidateCallback<FormData<DATA>>;
    onSubmit?: (data: FormData<DATA>) => void;
    onInvalid?: (
      data: FormData<DATA>,
      errors: ErrorRecord<FormData<DATA>>
    ) => void;
  };
  Blocks: {
    default: [
      {
        field: WithBoundArgs<
          typeof FieldComponent<DATA>,
          | 'data'
          | 'set'
          | 'errors'
          | 'registerField'
          | 'unregisterField'
          | 'triggerValidationFor'
          | 'fieldValidationEvent'
          | 'fieldRevalidationEvent'
        >;
      }
    ];
  };
}

/**
 * This internal data structure maintains information about each field that is registered to the form by `registerField`.
 */
class FieldData<
  DATA extends FormData,
  KEY extends FormKey<DATA> = FormKey<DATA>
> {
  constructor(fieldRegistration: FieldRegistrationData<DATA, KEY>) {
    this.validate = fieldRegistration.validate;
  }

  /**
   * tracked state that enabled a dynamic validation of a field *before* the whole form is submitted, e.g. by `@validateOn="blur" and the blur event being triggered for that particular field.
   */
  @tracked validationEnabled = false;

  /**
   * The *field* level validation callback passed to the field as in `<form.field @name="foo" @validate={{this.validateCallback}}>`
   */
  validate?: FieldValidateCallback<DATA, KEY>;
}

export default class HeadlessFormComponent<
  DATA extends UserData
> extends Component<HeadlessFormComponentSignature<DATA>> {
  FieldComponent: ComponentLike<HeadlessFormFieldComponentSignature<DATA>> =
    FieldComponent;

  // we cannot use (modifier "on") directly in the template due to https://github.com/emberjs/ember.js/issues/19869
  on = on;

  formElement?: HTMLFormElement;

  registerForm = modifier((el: HTMLFormElement, _p: []) => {
    this.formElement = el;
  }) as unknown as ModifierLike<unknown>; // @todo getting Glint errors without this. Try again with Glint 1.0 (beta)!

  /**
   * A copy of the passed `@data` stored internally, which is only passed back to the component consumer after a (successful) form submission.
   */
  internalData: DATA = new TrackedObject(this.args.data ?? {}) as DATA;

  fields = new Map<FormKey<FormData<DATA>>, FieldData<FormData<DATA>>>();

  /**
   * The last result of calling `this.validate()`.
   */
  @tracked lastValidationResult?: ErrorRecord<FormData<DATA>>;

  /**
   * When this is set to true by submitting the form, eventual validation errors are show for *all* field, regardless of their individual dynamic validation status in `FieldData#validationEnabled`
   */
  @tracked showAllValidations = false;

  get validateOn(): ValidateOn {
    return this.args.validateOn ?? 'submit';
  }

  get revalidateOn(): ValidateOn {
    return this.args.revalidateOn ?? 'change';
  }

  /**
   * Return the event type that will be listened on for dynamic validation (i.e. *before* submitting)
   */
  get fieldValidationEvent(): 'focusout' | 'change' | undefined {
    const { validateOn } = this;

    return validateOn === 'submit'
      ? // no need for dynamic validation, as validation always happens on submit
        undefined
      : // our component API expects "blur", but the actual blur event does not bubble up, so we use focusout internally instead
      validateOn === 'blur'
      ? 'focusout'
      : validateOn;
  }

  /**
   * Return the event type that will be listened on for dynamic *re*validation, i.e. updating the validation status of a field that has been previously marked as invalid
   */
  get fieldRevalidationEvent(): 'focusout' | 'change' | undefined {
    const { validateOn, revalidateOn } = this;

    return revalidateOn === 'submit'
      ? // no need for dynamic validation, as validation always happens on submit
        undefined
      : // when validation happens more frequently than revalidation, then we can ignore revalidation, because the validation handler will already cover us
      validateOn === 'change' ||
        (validateOn === 'blur' && revalidateOn === 'blur')
      ? undefined
      : // our component API expects "blur", but the actual blur event does not bubble up, so we use focusout internally instead
      revalidateOn === 'blur'
      ? 'focusout'
      : revalidateOn;
  }

  /**
   * Return true if validation has happened (by submitting or by an `@validateOn` event being triggered) and at least one field is invalid
   */
  get hasValidationErrors(): boolean {
    // Only consider validation errors for which we actually have a field rendered
    return this.lastValidationResult
      ? Object.keys(this.lastValidationResult).some((name) =>
          this.fields.has(name as FormKey<FormData<DATA>>)
        )
      : false;
  }

  /**
   * Call the passed validation callbacks, defined both on the whole form as well as on field level, and return the merged result for all fields.
   */
  @waitFor
  async validate(): Promise<ErrorRecord<FormData<DATA>>> {
    const nativeValidation = this.validateNative();
    const customFormValidation = await this.args.validate?.(this.internalData);
    const customFieldValidations: ErrorRecord<FormData<DATA>>[] = [];

    for (const [name, field] of this.fields) {
      const fieldValidationResult = await field.validate?.(
        this.internalData[name],
        name,
        this.internalData
      );

      if (fieldValidationResult) {
        customFieldValidations.push({
          [name]: fieldValidationResult,
        } as ErrorRecord<FormData<DATA>>);
      }
    }

    return mergeErrorRecord(
      nativeValidation,
      customFormValidation,
      ...customFieldValidations
    );
  }

  validateNative(): ErrorRecord<FormData<DATA>> | undefined {
    const form = this.formElement;

    assert(
      'Form element expected to be present. If you see this, please report it as a bug to ember-headless-form!',
      form
    );

    if (form.checkValidity()) {
      return;
    }

    const errors: ErrorRecord<FormData<DATA>> = {};

    for (const el of form.elements) {
      // This is just to make TS happy, as we need to access properties on el that only form elements have, but elements in `form.elements` are just typed as plain `Element`. Should never occur in reality.
      assert(
        'Unexpected form element. If you see this, please report it as a bug to ember-headless-form!',
        el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLButtonElement ||
          el instanceof HTMLFieldSetElement ||
          el instanceof HTMLObjectElement ||
          el instanceof HTMLOutputElement
      );

      if (el.validity.valid) {
        continue;
      }

      const name = el.name as FormKey<FormData<DATA>>;

      if (this.fields.has(name)) {
        errors[name] = [
          {
            type: 'native',
            value: this.internalData[name],
            message: el.validationMessage,
          },
        ];
      } else {
        warn(
          `An invalid form element with name "${name}" was detected, but this name is not used as a form field. It will be ignored for validation. Make sure to apply the correct name to custom form elements that participate in form validation!`,
          { id: 'headless-form.invalid-control-for-unknown-field' }
        );
      }
    }

    return errors;
  }

  /**
   * Return a mapping of field to validation errors, for all fields that are invalid *and* for which validation errors should be visible.
   * Validation errors will be visible for a certain field, if validation errors for *all* fields are visible, which is the case when trying to submit the form,
   * or when that field has triggered the event given by `@validateOn` for showing validation errors before submitting, e.g. on blur.
   */
  get visibleErrors(): ErrorRecord<FormData<DATA>> | undefined {
    if (!this.lastValidationResult) {
      return undefined;
    }

    const visibleErrors: ErrorRecord<FormData<DATA>> = {};

    for (const [field, errors] of Object.entries(this.lastValidationResult) as [
      FormKey<FormData<DATA>>,
      ValidationError<FormData<DATA>[FormKey<FormData<DATA>>]>[]
    ][]) {
      if (this.showErrorsFor(field)) {
        visibleErrors[field] = errors;
      }
    }

    return visibleErrors;
  }

  /**
   * Given a field name, return if eventual errors for the field should be visible. See `visibleErrors` for further details.
   */
  showErrorsFor(field: FormKey<FormData<DATA>>): boolean {
    return (
      this.showAllValidations ||
      (this.fields.get(field)?.validationEnabled ?? false)
    );
  }

  @action
  async onSubmit(e: Event): Promise<void> {
    e.preventDefault();

    this.lastValidationResult = await this.validate();
    this.showAllValidations = true;

    if (!this.hasValidationErrors) {
      this.args.onSubmit?.(this.internalData);
    } else {
      assert(
        'Validation errors expected to be present. If you see this, please report it as a bug to ember-headless-form!',
        this.lastValidationResult
      );
      this.args.onInvalid?.(this.internalData, this.lastValidationResult);
    }
  }

  @action
  registerField(
    name: FormKey<FormData<DATA>>,
    field: FieldRegistrationData<FormData<DATA>>
  ): void {
    assert(
      `You passed @name="${String(
        name
      )}" to the form field, but this is already in use. Names of form fields must be unique!`,
      !this.fields.has(name)
    );
    this.fields.set(name, new FieldData(field));
  }

  @action
  unregisterField(name: FormKey<FormData<DATA>>): void {
    this.fields.delete(name);
  }

  @action
  set<KEY extends FormKey<FormData<DATA>>>(key: KEY, value: DATA[KEY]): void {
    this.internalData[key] = value;
  }

  /**
   * Handle the `@validateOn` event for a certain field, e.g. "blur".
   * Associating the event with a field is done by looking at the event target's `name` attribute, which must match one of the `<form.field @name="...">` invocations by the user's template.
   * Validation will be triggered, and the particular field will be marked to show eventual validation errors.
   */
  @action
  async handleFieldValidation(e: Event | string): Promise<void> {
    let name: string;

    if (typeof e === 'string') {
      name = e;
    } else {
      const { target } = e;

      name = (target as HTMLInputElement).name;
    }

    if (name) {
      const field = this.fields.get(name as FormKey<FormData<DATA>>);

      if (field) {
        this.lastValidationResult = await this.validate();
        field.validationEnabled = true;
      }
    } else if (e instanceof Event) {
      warn(
        `An event of type "${e.type}" was received by headless-form, which is supposed to trigger validations for a certain field. But the name of that field could not be determined. Make sure that your control element has a \`name\` attribute matching the field, or use the yielded \`{{field.captureEvents}}\` to capture the events.`,
        { id: 'headless-form.validation-event-for-unknown-field' }
      );
    }
  }

  /**
   * Handle the `@revalidateOn` event for a certain field, e.g. "blur".
   * Associating the event with a field is done by looking at the event target's `name` attribute, which must match one of the `<form.field @name="...">` invocations by the user's template.
   * When a field has been already marked to show validation errors by `@validateOn`, then for revalidation another validation will be triggered.
   *
   * The use case here is to allow this to happen more frequently than the initial validation, e.g. `@validateOn="blur" @revalidateOn="change"`.
   */
  @action
  async handleFieldRevalidation(e: Event): Promise<void> {
    const { target } = e;
    const { name } = target as HTMLInputElement;

    if (name) {
      if (this.showErrorsFor(name as FormKey<FormData<DATA>>)) {
        this.lastValidationResult = await this.validate();
      }
    } else {
      warn(
        `An event of type "${e.type}" was received by headless-form, which is supposed to trigger validations for a certain field. But the name of that field could not be determined. Make sure that your control element has a \`name\` attribute matching the field, or use the yielded \`{{field.captureEvents}}\` to capture the events.`,
        { id: 'headless-form.validation-event-for-unknown-field' }
      );
    }
  }
}
