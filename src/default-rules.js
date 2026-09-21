export const defaultRules = [
  {
    id: 'username-required',
    field: 'username',
    type: 'required',
    message: 'Username is required.'
  },
  {
    id: 'username-length',
    field: 'username',
    type: 'expression',
    params: {
      expression: {
        and: [
          { '>=': [{ length: [{ ref: '$values.username' }] }, 3] },
          { '<=': [{ length: [{ ref: '$values.username' }] }, 20] }
        ]
      },
      message: 'Username must be 3-20 characters.'
    }
  },
  {
    id: 'username-available',
    field: 'username',
    type: 'async',
    params: { name: 'usernameAvailability', ttlMs: 30000 },
    message: 'Username validation failed.',
    requiresRules: ['username-required', 'username-length']
  },
  {
    id: 'age-required-when-business',
    field: 'age',
    type: 'required',
    when: { ref: '$values.accountType' },
    message: 'Age is required for business accounts.'
  },
  {
    id: 'age-range',
    field: 'age',
    type: 'between',
    params: { min: 18, max: 120 },
    message: 'Age must be between 18 and 120.'
  },
  {
    id: 'password-strength',
    field: 'password',
    type: 'expression',
    params: {
      expression: {
        and: [
          { '>=': [{ length: [{ ref: '$values.password' }] }, 8] },
          { regex: [{ ref: '$values.password' }, '[A-Z]'] },
          { regex: [{ ref: '$values.password' }, '[0-9]'] }
        ]
      },
      message: 'Use at least 8 characters with one uppercase letter and one number.'
    }
  },
  {
    id: 'password-confirmation',
    field: 'confirmPassword',
    type: 'equalsField',
    params: { field: 'password' },
    message: 'Password confirmation must match password.'
  },
  {
    id: 'country-required',
    field: 'country',
    type: 'oneOf',
    params: { values: ['CN', 'US'] },
    message: 'Choose CN or US.'
  },
  {
    id: 'postal-required',
    field: 'postalCode',
    type: 'required',
    message: 'Postal code is required.'
  },
  {
    id: 'postal-country-pattern',
    field: 'postalCode',
    type: 'async',
    params: {
      name: 'postalCodeAvailability',
      payload: { country: { ref: '$values.country' } },
      ttlMs: 30000
    },
    dependsOn: ['country'],
    requiresRules: ['postal-required', 'country-required']
  },
  {
    id: 'coupon-length-when-provided',
    field: 'coupon',
    type: 'minLength',
    params: { value: 4 },
    when: { not: [{ 'is-blank': [{ ref: '$values.coupon' }] }] },
    message: 'Coupon code must be at least 4 characters.'
  },
  {
    id: 'business-tax-id',
    field: 'taxId',
    type: 'required',
    when: { '==': [{ ref: '$values.accountType' }, 'business'] },
    message: 'Business accounts require a tax ID.'
  },
  {
    id: 'order-total-consistency',
    field: 'orderTotal',
    type: 'expression',
    params: {
      expression: {
        or: [
          { 'is-blank': [{ ref: '$values.orderTotal' }] },
          { and: [{ '>=': [{ ref: '$values.orderTotal' }, 0] }, { '<=': [{ ref: '$values.orderTotal' }, 1000000] }] }
        ]
      },
      message: 'Order total must be between 0 and 1,000,000.'
    }
  },
  {
    id: 'terms-required',
    field: 'terms',
    type: 'required',
    severity: 'error',
    message: 'You must accept the terms.'
  }
];
